// The storage API worker/index.mjs expects (sql.exec cursors, nested transactionSync) on a SQLite file.
// local/server.mjs keeps the chat database in it; tests and tools/bench_tokens.mjs use the default ':memory:'.
import {DatabaseSync} from 'node:sqlite';

export function storage(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const cursor = rows => ({toArray:() => rows, one() { if (rows.length !== 1) throw new Error('Expected exactly one row'); return rows[0]; },
    [Symbol.iterator]:() => rows[Symbol.iterator]()});
  const sql = {exec(query, ...args) {
    const statement = db.prepare(query);
    return cursor(statement.columns().length ? statement.all(...args) : (statement.run(...args), []));
  }};
  let depth = 0;
  const transactionSync = fn => {
    const name = 'tx' + depth++;
    db.exec('SAVEPOINT ' + name);
    try { const result = fn(); db.exec('RELEASE ' + name); return result; }
    catch (error) { db.exec('ROLLBACK TO ' + name); db.exec('RELEASE ' + name); throw error; }
    finally { depth--; }
  };
  return {db, storage:{sql, transactionSync}};
}
