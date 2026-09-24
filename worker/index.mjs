import {SourceStore} from './source-store.mjs';
import {DurableObject} from 'cloudflare:workers';
import {Archive, CacheStore, hash, ChatError, OpenRouter, MODEL, LIMITS, validate, readLimited, converse, rememberTurn} from './core.mjs';

// Invalid configuration falls back to a finite limit, never unlimited admission.
const limit = (env, key, fallback) => {
  const value = Number(env[key]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

const allowed = (request, env) => !request.headers.get('Origin') ||
  (env.CHAT_ALLOWED_ORIGINS || '').split(',').includes(request.headers.get('Origin'));
function headers(request, type) {
  const value = {'Content-Type':type, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', Vary:'Origin'};
  if (request.headers.get('Origin')) value['Access-Control-Allow-Origin'] = request.headers.get('Origin');
  return value;
}
const json = (request, value, status = 200) => new Response(JSON.stringify(value),
  {status, headers:headers(request, 'application/json; charset=utf-8')});

// The public Worker only routes requests. Document processing uses the Durable Object's
// 30-second active CPU allowance; waiting for OpenRouter does not use that CPU budget.
export default {
  async fetch(request, env) {
    if (!allowed(request, env)) return new Response('Origin tidak diizinkan', {status:403});
    const path = new URL(request.url).pathname;
    if (!['/api/chat', '/api/chat/config', '/api/chat/metrics', '/api/chat/index'].includes(path)) return new Response('Not found', {status:404});
    if (path === '/api/chat/metrics' || path === '/api/chat/index') {
      if ((path === '/api/chat/metrics' ? request.method !== 'GET' : !['GET','POST'].includes(request.method)) || !env.CHAT_METRICS_TOKEN || request.headers.get('Authorization') !== 'Bearer ' + env.CHAT_METRICS_TOKEN)
        return json(request,{error:'Tidak diizinkan.'},403);
      return env.CHAT.get(env.CHAT.idFromName('archive-global-v1')).fetch(request);
    }
    if (request.method === 'OPTIONS') return new Response(null, {status:204, headers:{
      ...headers(request, 'text/plain'), 'Access-Control-Allow-Methods':'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type', 'Access-Control-Max-Age':'600'}});
    if (request.method === 'GET' && path === '/api/chat/config')
      return json(request, {ready:!!env.OPENROUTER_API_KEY, model:MODEL});
    if (request.method !== 'POST' || path !== '/api/chat') return new Response('Method not allowed', {status:405});
    if (!env.OPENROUTER_API_KEY) return json(request, {error:'Percakapan belum diaktifkan pengelola.'}, 503);
    // A single named object makes limits and concurrent slots consistent across locations.
    return env.CHAT.get(env.CHAT.idFromName('archive-global-v1')).fetch(request);
  }
};

export class ArchiveChat extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sources = new SourceStore(ctx);
    this.archive = new Archive(env.ASSETS,this.sources);
    this.active = new Map(); this.receiving = 0;
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS requests (stamp INTEGER, client TEXT)');
    sql.exec('CREATE INDEX IF NOT EXISTS request_time ON requests(stamp)');
    sql.exec('CREATE TABLE IF NOT EXISTS ingress (stamp INTEGER, client TEXT)');
    sql.exec('CREATE TABLE IF NOT EXISTS budget (day INTEGER PRIMARY KEY, bytes INTEGER, tokens INTEGER)');
    sql.exec('CREATE TABLE IF NOT EXISTS conversations (token TEXT PRIMARY KEY, client TEXT, expires INTEGER, turns INTEGER, history TEXT)');
    this.cache = new CacheStore(sql);
  }
  admit(client) {
    const now = Math.floor(Date.now() / 1000), sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec('DELETE FROM ingress WHERE stamp <= ?', now - 60);
      const total = sql.exec('SELECT COUNT(*) AS n FROM ingress').one().n;
      const own = sql.exec('SELECT COUNT(*) AS n FROM ingress WHERE client = ?', client).one().n;
      if (total >= 120 || own >= 12) throw new ChatError('Terlalu banyak permintaan. Tunggu satu menit.');
      sql.exec('INSERT INTO ingress VALUES (?, ?)', now, client);
    });
  }
  reserve(client) {
    const now = Math.floor(Date.now() / 1000), day = Math.floor(now / 86400) * 86400;
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec('DELETE FROM requests WHERE stamp < ?', Math.min(day, now - 3600));
      const total = sql.exec('SELECT COUNT(*) AS n FROM requests WHERE stamp >= ?', day).one().n;
      const own = sql.exec('SELECT COUNT(*) AS n FROM requests WHERE stamp >= ? AND client = ?', now - 3600, client).one().n;
      if (total >= limit(this.env, 'CHAT_DAILY_REQUESTS', 3000) || own >= limit(this.env, 'CHAT_HOURLY_PER_IP', 120))
        throw new ChatError('Batas percakapan sementara sudah tercapai. Silakan coba lagi nanti.');
      sql.exec('INSERT INTO requests VALUES (?, ?)', now, client);
    });
  }
  spend(bytes, tokens) {
    const day = Math.floor(Date.now() / 86400000), sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec('DELETE FROM budget WHERE day < ?', day);
      const used = sql.exec('SELECT bytes, tokens FROM budget WHERE day = ?', day).toArray()[0] || {bytes:0, tokens:0};
      if (used.bytes + bytes > 80000000 || used.tokens + tokens > 500000)
        throw new ChatError('Anggaran AI hari ini sudah tercapai. Silakan kembali besok.');
      sql.exec('INSERT OR REPLACE INTO budget VALUES (?, ?, ?)', day, used.bytes + bytes, used.tokens + tokens);
    });
  }
  conversation(token, client) {
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM conversations WHERE expires <= ?', Date.now());
    if (!token) return {turns:0, history:[]};
    const row = sql.exec('SELECT turns, history FROM conversations WHERE token = ? AND client = ?', token, client).toArray()[0];
    if (!row || row.turns >= 20) throw new ChatError('Percakapan berakhir atau jaringan berubah. Pilih Percakapan baru.');
    return {turns:row.turns, history:JSON.parse(row.history)};
  }
  remember(client, conversation, question, result) {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
    const history = rememberTurn(conversation.history, question, result);
    // Short-lived, server-authored history. No client can supply assistant/system messages.
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec('INSERT INTO conversations VALUES (?, ?, ?, ?, ?)', token, client,
        Date.now() + 3600000, conversation.turns + 1, JSON.stringify(history));
    });
    return token;
  }
  async fetch(request) {
    if (new URL(request.url).pathname === '/api/chat/index') {
      if (!this.env.CHAT_METRICS_TOKEN || request.headers.get('Authorization') !== 'Bearer ' + this.env.CHAT_METRICS_TOKEN)
        return json(request,{error:'Tidak diizinkan.'},403);
      const index=await this.archive.manifest();
      if(request.method==='GET')return json(request,this.sources.status(index));
      if(request.method!=='POST')return json(request,{error:'Method not allowed'},405);
      try {
        const body=JSON.parse(await readLimited(request.body,4096,5000,request.signal));
        const doc=index.docs.find(d=>d.document_id===body.document_id);
        if(!doc || Object.keys(body).some(k=>k!=='document_id'))return json(request,{error:'Dokumen tidak dikenal.'},400);
        return json(request,await this.sources.importDocument(index,doc,await this.archive.read(doc.evidence_asset)));
      } catch { return json(request,{error:'Impor indeks gagal; dokumen belum diaktifkan.'},500); }
    }
    if (new URL(request.url).pathname === '/api/chat/metrics') {
      if (!this.env.CHAT_METRICS_TOKEN || request.headers.get('Authorization') !== 'Bearer ' + this.env.CHAT_METRICS_TOKEN)
        return json(request,{error:'Tidak diizinkan.'},403);
      const params=new URL(request.url).searchParams;
      const days = Math.max(1,Math.min(365,Number(params.get('days')) || 7));
      const limit=Math.max(1,Math.min(500,Number(params.get('limit')) || 100));
      const offset=Math.max(0,Math.min(100000,Number(params.get('offset')) || 0));
      return json(request,this.cache.report(days,limit,offset));
    }
    // Keep body uploads bounded before expensive decoding, parsing, or document retrieval.
    if (this.receiving >= 4) return json(request, {error:'Server sedang sibuk. Coba sebentar lagi.'}, 429);
    this.receiving++;
    const analysisId=crypto.randomUUID(),started=Date.now();
    let body, client, conversation;
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.headers.get('CF-Connecting-IP') || 'local'));
      client = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
      try { this.admit(client); } catch (error) { return json(request, {error:error.message}, 429); }
      if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json' ||
          Number(request.headers.get('Content-Length') || 0) > LIMITS.body)
        throw new ChatError('Gunakan pertanyaan singkat dalam format yang tersedia.');
      const incoming = JSON.parse(await readLimited(request.body, LIMITS.body, 5000, request.signal));
      body = validate(incoming);
      this.cache.question(analysisId,await hash([client,this.env.CHAT_METRICS_TOKEN || 'local']),incoming.question,body.question);
      conversation = this.conversation(body.context, client);
    } catch (error) {
      if(body)this.cache.finishQuestion(analysisId,'invalid_context');
      return json(request, {error:error instanceof ChatError ? error.message : 'Pertanyaan tidak valid atau terlalu panjang.'}, 400);
    } finally { this.receiving--; }
    const ownActive = [...this.active.values()].filter(value => value === client).length;
    const ipBusy = ownActive >= limit(this.env, 'CHAT_CONCURRENT_PER_IP', 5);
    if (this.active.size >= limit(this.env, 'CHAT_CONCURRENT_REQUESTS', 10) || ipBusy) {
      this.cache.finishQuestion(analysisId,'busy');
      return json(request, {error:ipBusy
        ? 'Terlalu banyak analisis berjalan dari jaringan yang sama. Tunggu salah satu selesai.'
        : 'Semua slot analisis sedang terpakai. Coba beberapa saat lagi.'}, 429);
    }
    try { this.reserve(client); }
    catch (error) { this.cache.finishQuestion(analysisId,'quota');return json(request, {error:error instanceof ChatError ? error.message : 'Batas pemakaian belum dapat diperiksa.'}, 429); }
    this.cache.finishQuestion(analysisId,'running');
    this.active.set(analysisId, client);
    const controller = new AbortController(), stream = new TransformStream(), writer = stream.writable.getWriter();
    const encoder = new TextEncoder();
    // A client that never reads cannot hold a slot or accumulate unbounded output.
    const write = async value => {
      let timer;
      try {
        await Promise.race([writer.write(encoder.encode(JSON.stringify(value) + '\n')),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Slow reader')), 10000); })]);
      } catch (error) { controller.abort(); writer.abort(error).catch(() => {}); throw error; }
      finally { clearTimeout(timer); }
    };
    const emit = value => { controller.signal.throwIfAborted(); return write(value); };
    const timer = setTimeout(() => controller.abort(), 8 * 60 * 1000);
    writer.closed.catch(() => controller.abort());
    const model = new OpenRouter(this.env.OPENROUTER_API_KEY, controller.signal, undefined, (bytes,tokens) => this.spend(bytes,tokens));
    const retrieval = {};
    const run = async () => {
      let outcome = 'error';
      try {
        const result = await converse(this.archive, model, body.question, conversation.history, emit, controller.signal,
          {cache:this.cache,client,metrics:retrieval});
        controller.signal.throwIfAborted();
        // An answer cut at the length limit does not become history; the previous context stays valid.
        const context = result.incomplete && body.context ? body.context
          : this.remember(client, conversation, body.question, result.incomplete ? {...result, answer:'(jawaban terpotong)'} : result);
        await emit({type:'done', documents:result.documents, batches:result.batches, model:MODEL, context,
          usage:model.usage(),cache_hit:!!result.cache_hit,clarification:!!result.clarification});
        outcome = result.clarification ? 'clarification' : 'complete';
      } catch (error) {
        retrieval.error_name = error.name;
        const message = String(error.message || '');
        retrieval.error_kind = /too many.*(?:subrequests|api requests)/i.test(message) ? 'subrequest_limit'
          : /(?:SQLITE|database|SQL)/i.test(message) ? 'storage_error'
          : /(?:CPU|memory limit)/i.test(message) ? 'runtime_limit'
          : /(?:network|fetch|connection)/i.test(message) ? 'network_error'
          : error instanceof ChatError ? 'handled' : 'unexpected';
        if (!(error instanceof ChatError)) console.error('Chat failure:', retrieval.error_name, retrieval.error_kind, retrieval.stage);
        const text = retrieval.error_kind === 'subrequest_limit' ? 'Pencarian melampaui kapasitas pembacaan arsip. Persempit topik atau coba lagi setelah indeks diperbarui.'
          : error instanceof ChatError ? error.message : 'Koneksi atau proses analisis terhenti. Silakan coba lagi.';
        try { await write({type:'error', text}); } catch {}
      } finally {
        retrieval.elapsed_ms=Date.now()-started;
        if(outcome==='error'&&controller.signal.aborted)outcome='cancelled';
        try { this.cache.record(analysisId,outcome,{usage:model.usage(),calls:model.receipts,retrieval}); }
        catch (error) { console.error('Usage storage failed:',error.name); }
        clearTimeout(timer); controller.abort(); this.active.delete(analysisId);
        writer.close().catch(() => {});
      }
    };
    this.ctx.waitUntil(run());
    return new Response(stream.readable, {headers:headers(request, 'application/x-ndjson; charset=utf-8')});
  }
}
