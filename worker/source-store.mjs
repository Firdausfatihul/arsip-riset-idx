// Durable, lossless source index. Populated by the private sync endpoint, never by a model.
import {hash} from './cache.mjs';
export const SOURCE_SCHEMA = 'sources-v1';
const keyOf = (doc, version) => [SOURCE_SCHEMA,version,doc.document_id,doc.document_hash].join(':');
const quote = text => '"' + text.replaceAll('"','""') + '"';
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
  read(doc,index) {
    const key=keyOf(doc,index.retrieval_version);
    if(!this.sql.exec('SELECT records FROM source_documents WHERE doc_key=?',key).toArray().length)return null;
    return {version:index.retrieval_version,document_hash:doc.document_hash,coverage:'full-source-partition',
      records:this.sql.exec('SELECT data FROM source_passages WHERE doc_key=? ORDER BY ordinal',key).toArray().map(r=>JSON.parse(r.data))};
  }
  search(index,terms) {
    if(this.status(index).pending.length)return null;
    const query=terms.filter(t=>/[\p{L}\p{N}]/u.test(t)).map(quote).join(' OR ');
    if(!query)return [];
    const keys=new Set(this.sql.exec('SELECT DISTINCT p.doc_key FROM source_fts f JOIN source_passages p ON p.id=f.rowid WHERE source_fts MATCH ?',query).toArray().map(r=>r.doc_key));
    return index.docs.filter(d=>keys.has(keyOf(d,index.retrieval_version))).sort((a,b)=>b.end.localeCompare(a.end)||b.name.localeCompare(a.name));
  }
}
