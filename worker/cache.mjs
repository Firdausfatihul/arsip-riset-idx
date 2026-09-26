// Shared source-derived data. No conversations or user text are stored in cache keys.
export async function hash(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}

export class CacheStore {
  constructor(sql) {
    this.sql = sql; this.pending = new Map();
    sql.exec('CREATE TABLE IF NOT EXISTS evidence_cache (kind TEXT, cache_key TEXT, content TEXT, expires INTEGER, touched INTEGER, bytes INTEGER, PRIMARY KEY(kind, cache_key))');
    sql.exec('CREATE INDEX IF NOT EXISTS evidence_expiry ON evidence_cache(expires)');
    sql.exec(`CREATE VIEW IF NOT EXISTS issuer_evidence AS SELECT
      json_extract(e.content,'$.document_id') AS document_id,
      json_extract(e.content,'$.document_hash') AS document_hash,
      json_extract(e.content,'$.source_path') AS source_path,
      json_extract(e.content,'$.document_date') AS document_date,
      json_extract(e.content,'$.tickers') AS query_terms,
      json_extract(r.value,'$.tickers') AS tickers,
      json_extract(r.value,'$.event_date') AS event_date,
      json_extract(r.value,'$.line') AS source_line,
      json_extract(r.value,'$.content') AS content
      FROM evidence_cache e, json_each(e.content,'$.rows') r WHERE e.kind='source'`);
    sql.exec('CREATE TABLE IF NOT EXISTS analysis_usage (id TEXT PRIMARY KEY, stamp INTEGER, result TEXT, metrics TEXT)');
    sql.exec('CREATE INDEX IF NOT EXISTS usage_stamp ON analysis_usage(stamp)');
    sql.exec('CREATE TABLE IF NOT EXISTS question_events (id TEXT PRIMARY KEY, stamp INTEGER, user_key TEXT, question TEXT, normalized TEXT, status TEXT, terms TEXT)');
    sql.exec('CREATE INDEX IF NOT EXISTS question_stamp ON question_events(stamp)');
    sql.exec('CREATE INDEX IF NOT EXISTS question_normalized ON question_events(normalized)');
    // Added with agentic mode; rows from before carry no mode and count as normal use.
    try { sql.exec('ALTER TABLE question_events ADD COLUMN mode TEXT'); } catch { /* column exists */ }
  }
  get(kind, key) {
    const row = this.sql.exec('SELECT content FROM evidence_cache WHERE kind = ? AND cache_key = ? AND expires > ?', kind, key, Date.now()).toArray()[0];
    if (!row) return null;
    this.sql.exec('UPDATE evidence_cache SET touched = ? WHERE kind = ? AND cache_key = ?', Date.now(), kind, key);
    return JSON.parse(row.content);
  }
  put(kind, key, value, ttl) {
    const content = JSON.stringify(value), bytes = new TextEncoder().encode(content).length;
    if (bytes > 1000000) return; // Oversize entries never displace the entire shared cache.
    const now = Date.now();
    this.sql.exec('DELETE FROM evidence_cache WHERE expires <= ?', now);
    // Immutable sources have no time expiry; bounded LRU storage still applies.
    this.sql.exec('INSERT OR REPLACE INTO evidence_cache VALUES (?, ?, ?, ?, ?, ?)', kind, key, content, ttl === undefined ? 253402300799000 : now + ttl, now, bytes);
    // Bound both stored bytes and row count, using SQL rather than loading source text.
    while (true) {
      const usage = this.sql.exec('SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes FROM evidence_cache').toArray()[0];
      if (usage.n <= 512 && usage.bytes <= 16000000) break;
      this.sql.exec('DELETE FROM evidence_cache WHERE rowid IN (SELECT rowid FROM evidence_cache ORDER BY touched LIMIT 16)');
    }
  }
  async once(kind, key, compute, ttl) {
    const found = this.get(kind, key);
    if (found !== null) return {value:found, hit:true, shared:false};
    const id = kind + ':' + key;
    if (this.pending.has(id)) return {value:await this.pending.get(id), hit:true, shared:true};
    // Answers cut at the length limit are shown once but never reused.
    const pending = Promise.resolve().then(compute).then(value => { if (!value?.incomplete) this.put(kind, key, value, ttl); return value; });
    this.pending.set(id, pending);
    try { return {value:await pending, hit:false, shared:false}; }
    finally { this.pending.delete(id); }
  }
  record(id, result, metrics) {
    const now = Date.now();
    this.sql.exec('DELETE FROM analysis_usage WHERE stamp < ?', now - 365 * 86400000);
    this.sql.exec('INSERT OR REPLACE INTO analysis_usage VALUES (?, ?, ?, ?)', id, now, result, JSON.stringify(metrics));
    this.finishQuestion(id,result,metrics.retrieval?.terms || []);
  }
  question(id, userKey, text, normalized=text, mode='archive') {
    const now=Date.now();
    this.sql.exec('DELETE FROM question_events WHERE stamp < ?',now-365*86400000);
    this.sql.exec('INSERT INTO question_events (id,stamp,user_key,question,normalized,status,terms,mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,now,userKey,text,normalized.toLowerCase().replace(/\s+/g,' ').trim(),'received','[]',mode === 'agentic' ? 'agentic' : 'archive');
  }
  finishQuestion(id,status,terms=[]) {
    this.sql.exec('UPDATE question_events SET status = ?, terms = ? WHERE id = ?',status,JSON.stringify(terms),id);
  }
  report(days = 7, limit = 100, offset = 0) {
    const since=Date.now()-days*86400000;
    const rows = this.sql.exec('SELECT id, stamp, result, metrics FROM analysis_usage WHERE stamp >= ? ORDER BY stamp DESC LIMIT ? OFFSET ?', since,limit,offset).toArray();
    const records = rows.map(r => ({id:r.id, stamp:r.stamp, result:r.result, ...JSON.parse(r.metrics)}));
    const fields={provider_calls:'usage.calls',known_cost_usd:'usage.known_cost_usd',prompt_tokens:'usage.prompt_tokens',
      completion_tokens:'usage.completion_tokens',cached_tokens:'usage.cached_tokens',missing_usage_calls:'usage.missing_usage_calls',answer_cache_hits:'retrieval.answer_cache_hit'};
    const sums=Object.entries(fields).map(([name,path])=>`COALESCE(SUM(json_extract(metrics,'$.${path}')),0) AS ${name}`).join(',');
    const total=this.sql.exec('SELECT COUNT(*) AS requests,'+sums+' FROM analysis_usage WHERE stamp >= ?',since).toArray()[0];
    const input=this.sql.exec('SELECT COUNT(*) AS inputs, COUNT(DISTINCT user_key) AS anonymous_clients FROM question_events WHERE stamp >= ?',since).toArray()[0];
    // Normal and agentic use side by side, so agentic cost can be watched on its own.
    const cost="COALESCE(json_extract(a.metrics,'$.usage.known_cost_usd'),0)";
    const by_mode=this.sql.exec(`SELECT COALESCE(q.mode,'archive') AS mode,COUNT(*) AS inputs,
      SUM(q.status='complete') AS completed,SUM(q.status NOT IN ('complete','clarification','running','received')) AS failed,
      COALESCE(SUM(${cost}),0) AS known_cost_usd,COALESCE(MAX(${cost}),0) AS max_cost_usd,
      COALESCE(SUM(json_extract(a.metrics,'$.usage.calls')),0) AS provider_calls,
      COALESCE(SUM(json_extract(a.metrics,'$.usage.prompt_tokens')),0) AS prompt_tokens,
      COALESCE(SUM(json_extract(a.metrics,'$.usage.completion_tokens')),0) AS completion_tokens,
      COALESCE(SUM(json_extract(a.metrics,'$.usage.missing_usage_calls')),0) AS missing_usage_calls,
      COALESCE(SUM(json_extract(a.metrics,'$.retrieval.answer_cache_hit')),0) AS answer_cache_hits,
      COALESCE(SUM(json_extract(a.metrics,'$.retrieval.agent_tool_calls')),0) AS tool_calls,
      COALESCE(SUM(json_extract(a.metrics,'$.retrieval.datacat_cache_hits')),0) AS datacat_cache_hits
      FROM question_events q LEFT JOIN analysis_usage a ON a.id=q.id WHERE q.stamp >= ? GROUP BY 1 ORDER BY 1`,since).toArray();
    const daily_by_mode=this.sql.exec(`SELECT strftime('%Y-%m-%d',q.stamp/1000,'unixepoch') AS day,COALESCE(q.mode,'archive') AS mode,
      COUNT(*) AS inputs,COALESCE(SUM(${cost}),0) AS known_cost_usd
      FROM question_events q LEFT JOIN analysis_usage a ON a.id=q.id WHERE q.stamp >= ? GROUP BY 1,2 ORDER BY 1,2`,since).toArray();
    const questions=this.sql.exec(`SELECT q.id,q.stamp,q.user_key,q.question,q.status,q.terms,COALESCE(q.mode,'archive') AS mode,a.metrics
      FROM question_events q LEFT JOIN analysis_usage a ON a.id=q.id WHERE q.stamp >= ? ORDER BY q.stamp DESC LIMIT ? OFFSET ?`,since,limit,offset).toArray()
      .map(r=>({...r,terms:JSON.parse(r.terms),metrics:r.metrics?JSON.parse(r.metrics):null}));
    const top_questions=this.sql.exec(`SELECT q.normalized AS question,COUNT(*) AS count,
      COALESCE(SUM(json_extract(a.metrics,'$.usage.known_cost_usd')),0) AS known_cost_usd
      FROM question_events q LEFT JOIN analysis_usage a ON a.id=q.id WHERE q.stamp >= ?
      GROUP BY q.normalized ORDER BY count DESC,known_cost_usd DESC LIMIT 30`,since).toArray();
    const top_terms=this.sql.exec(`SELECT t.value AS term,COUNT(*) AS count FROM question_events q,json_each(q.terms) t
      WHERE q.stamp >= ? GROUP BY t.value ORDER BY count DESC LIMIT 30`,since).toArray();
    const expensive_questions=this.sql.exec(`SELECT q.normalized AS question,COUNT(*) AS count,
      COALESCE(SUM(json_extract(a.metrics,'$.usage.known_cost_usd')),0) AS known_cost_usd
      FROM question_events q LEFT JOIN analysis_usage a ON a.id=q.id WHERE q.stamp >= ?
      GROUP BY q.normalized ORDER BY known_cost_usd DESC,count DESC LIMIT 30`,since).toArray();
    const outcomes=this.sql.exec('SELECT status,COUNT(*) AS count FROM question_events WHERE stamp >= ? GROUP BY status',since).toArray();
    const daily=this.sql.exec(`SELECT strftime('%Y-%m-%d',q.stamp/1000,'unixepoch') AS day,COUNT(*) AS inputs,
      COALESCE(SUM(json_extract(a.metrics,'$.usage.known_cost_usd')),0) AS known_cost_usd
      FROM question_events q LEFT JOIN analysis_usage a ON a.id=q.id WHERE q.stamp >= ? GROUP BY day ORDER BY day`,since).toArray();
    return {days,total:{...total,...input},by_mode,daily_by_mode,top_questions,expensive_questions,top_terms,outcomes,daily,
      pagination:{limit,offset,total:input.inputs},questions,records};
  }
}
