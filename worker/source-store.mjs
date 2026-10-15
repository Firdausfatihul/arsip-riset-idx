// Durable, lossless source index. Filled at server start-up (local/server.mjs), never by a model.
import {hash} from './cache.mjs';
import {pattern} from './retrieval.mjs';
export const SOURCE_SCHEMA = 'sources-v1';
const keyOf = (doc, version) => [SOURCE_SCHEMA,version,doc.document_id,doc.document_hash].join(':');
const quote = text => '"' + text.replaceAll('"','""') + '"';
// "issuer-passages-v3" is newer than "issuer-passages-v2" (same name, higher number); other names do not compare.
const newerVersion = (key, active) => {
  const version = key.split(':')[1] || '', a = version.match(/^(.*-v)(\d+)$/), b = String(active).match(/^(.*-v)(\d+)$/);
  return !!(a && b && a[1] === b[1] && Number(a[2]) > Number(b[2]));
};
export class SourceStore {
  constructor(ctx) {
    this.ctx=ctx;this.sql=ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS source_documents (doc_key TEXT PRIMARY KEY, records INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS source_passages (id INTEGER PRIMARY KEY, doc_key TEXT, ordinal INTEGER, data TEXT, UNIQUE(doc_key,ordinal))');
    this.sql.exec('CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(title, context, content)');
  }
  status(index) {
    const stored=new Map(this.sql.exec('SELECT doc_key, records FROM source_documents').toArray().map(r=>[r.doc_key,r.records]));
    const pending=index.docs.filter(d=>!stored.has(keyOf(d,index.retrieval_version)));
    return {version:index.version,documents:index.docs.length,ready:index.docs.length-pending.length,
      records:index.docs.reduce((n,d)=>n+(stored.get(keyOf(d,index.retrieval_version))||0),0),pending:pending.map(d=>d.document_id)};
  }
  // Removes stored documents the active manifest no longer names (an older evidence VERSION or document hash):
  // without this every version bump keeps the previous copy forever. One transaction per document, so an
  // interruption leaves only whole documents; running again finishes the rest. Keys of the active manifest are
  // never touched, and a manifest without documents or a retrieval version removes nothing. Nothing is removed until
  // every active document is imported, and rows of a newer evidence version are kept: a push that fails half way and
  // the rollback to the previous copy keep the progress of both versions, so the next push resumes instead of
  // importing from zero.
  prune(index) {
    if(!index?.retrieval_version || !Array.isArray(index.docs) || !index.docs.length)return {removed:0,records:0};
    if(this.status(index).pending.length)return {removed:0,records:0,deferred:true};
    const active=new Set(index.docs.map(d=>keyOf(d,index.retrieval_version)));
    const stale=this.sql.exec('SELECT doc_key FROM source_documents UNION SELECT DISTINCT doc_key FROM source_passages').toArray()
      .map(r=>r.doc_key).filter(key=>!active.has(key) && !newerVersion(key,index.retrieval_version));
    let records=0;
    for(const key of stale) records+=this.ctx.storage.transactionSync(()=>{
      // source_fts stores its own copy of the text (not external content), so its rows are deleted by rowid.
      this.sql.exec('DELETE FROM source_fts WHERE rowid IN (SELECT id FROM source_passages WHERE doc_key=?)',key);
      const n=this.sql.exec('DELETE FROM source_passages WHERE doc_key=? RETURNING id',key).toArray().length;
      this.sql.exec('DELETE FROM source_documents WHERE doc_key=?',key);
      return n;
    });
    // Deletes leave tombstones in the FTS5 segments. After a version bump (most rows removed) one merge is cheap and
    // drops them; for a few replaced documents FTS5's own automerge is enough, a full rewrite would stall start-up.
    const left=this.sql.exec('SELECT COUNT(*) n FROM source_passages').toArray()[0].n;
    if(records && records>=left)this.sql.exec("INSERT INTO source_fts(source_fts) VALUES('optimize')");
    return {removed:stale.length,records};
  }
  async importDocument(index, doc, data) {
    const key=keyOf(doc,index.retrieval_version);
    if(this.sql.exec('SELECT records FROM source_documents WHERE doc_key=?',key).toArray().length) return {skipped:true};
    if(data.version!==index.retrieval_version || data.document_hash!==doc.document_hash || data.document_id!==doc.document_id ||
      data.coverage!=='full-source-partition' || !Array.isArray(data.records) ||
      await hash(data.records.map(r=>r.content).join(''))!==doc.document_hash) throw new Error('Source integrity mismatch');
    this.ctx.storage.transactionSync(()=>{
      // Another sync request may have completed while the hash was being checked.
      if(this.sql.exec('SELECT records FROM source_documents WHERE doc_key=?',key).toArray().length)return;
      for(const [i,row] of data.records.entries()) {
        const result=this.sql.exec('INSERT INTO source_passages(doc_key,ordinal,data) VALUES(?,?,?) RETURNING id',key,i,JSON.stringify(row)).toArray()[0];
        this.sql.exec('INSERT INTO source_fts(rowid,title,context,content) VALUES(?,?,?,?)',result.id,doc.title,row.context,row.content);
      }
      this.sql.exec('INSERT INTO source_documents VALUES(?,?)',key,data.records.length);
    });
    return {skipped:false,records:data.records.length};
  }
  // Imports every document of the index not stored yet; read(doc) gives its evidence data, progress(n,total) follows.
  async importPending(index,read,progress=()=>{}) {
    const pending=this.status(index).pending.map(id=>index.docs.find(d=>d.document_id===id));
    for(const [n,doc] of pending.entries()){await this.importDocument(index,doc,await read(doc));progress(n+1,pending.length);}
  }
  read(doc,index) {
    const key=keyOf(doc,index.retrieval_version);
    if(!this.sql.exec('SELECT records FROM source_documents WHERE doc_key=?',key).toArray().length)return null;
    return {version:index.retrieval_version,document_hash:doc.document_hash,coverage:'full-source-partition',
      records:this.sql.exec('SELECT data FROM source_passages WHERE doc_key=? ORDER BY ordinal',key).toArray().map(r=>JSON.parse(r.data))};
  }
  search(index,terms) {
    if(this.status(index).pending.length)return null;
    const tickers=new Set(index.tickers),keys=new Set();
    for(const term of terms.filter(t=>/[\p{L}\p{N}]/u.test(t))) {
      // FTS5 folds case, so ticker hits are re-checked against the exact capitalised code.
      const exact=tickers.has(term)?pattern(term,tickers):null;
      const rows=this.sql.exec(`SELECT DISTINCT p.doc_key${exact?', f.content':''} FROM source_fts f JOIN source_passages p ON p.id=f.rowid WHERE source_fts MATCH ?`,quote(term)).toArray();
      for(const r of rows)if(!exact || exact.test(r.content))keys.add(r.doc_key);
    }
    return index.docs.filter(d=>keys.has(keyOf(d,index.retrieval_version))).sort((a,b)=>b.end.localeCompare(a.end)||b.name.localeCompare(a.name));
  }
}
