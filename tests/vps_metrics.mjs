// local/vps.mjs metrics: the script piped to node on the VPS, run here against a temp copy of /srv/arsip/app.
// It reports from the chat database without writing to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CacheStore} from '../worker/cache.mjs';
import {storage} from '../local/server.mjs';
import {metricsScript} from '../local/vps.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('metrics script reports the VPS chat database read-only', () => {
  const app = mkdtempSync(path.join(tmpdir(), 'arsip-metrics-'));
  try {
    symlinkSync(path.join(ROOT, 'worker'), path.join(app, 'worker'));
    mkdirSync(path.join(app, '.local'));
    const {db, storage:store} = storage(path.join(app, '.local/chat.sqlite'));
    const cache = new CacheStore(store.sql);
    cache.question('q1', 'client-a', 'analisis SOCI', 'analisis SOCI', 'agentic');
    cache.record('q1', 'complete', {usage:{calls:2, known_cost_usd:0}, retrieval:{terms:['SOCI']}});
    cache.question('q2', 'client-b', 'apa kata stockbit');
    db.close();
    // A WAL reader may add the -shm/-wal side files (the running server has them anyway); the database stays as it was.
    const digest = () => createHash('sha256').update(readFileSync(path.join(app, '.local/chat.sqlite'))).digest('hex');
    const before = digest();
    const run = opt => JSON.parse(execFileSync(process.execPath, ['--no-warnings', '--input-type=module'],
      {input:metricsScript(opt, app), encoding:'utf8'}));
    const report = run({days:'7', limit:'1'});
    assert.equal(report.days, 7);
    assert.equal(report.total.inputs, 2);
    assert.equal(report.total.provider_calls, 2);
    assert.deepEqual(report.by_mode.map(m => [m.mode, m.inputs]), [['agentic', 1], ['archive', 1]]);
    assert.deepEqual(report.top_terms, [{term:'SOCI', count:1}]);
    assert.equal(report.questions.length, 1);
    assert.deepEqual(report.pagination, {limit:1, offset:0, total:2});
    // Out-of-range or non-numeric options are clamped into range, never passed to SQL as text.
    const clamped = run({days:'9999', limit:'x', offset:'-5'});
    assert.deepEqual([clamped.days, clamped.pagination], [365, {limit:1, offset:0, total:2}]);
    assert.equal(digest(), before, 'database unchanged');
  } finally { rmSync(app, {recursive:true, force:true}); }
});
