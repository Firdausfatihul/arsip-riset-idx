// local/server.mjs start-up end to end: a fake `claude` CLI and ARSIP_STATE in a temp folder holding a tiny built
// archive. Checks the exit codes the VPS systemd unit relies on (78 = stay down, 1 = retry), the source index import,
// that the loopback listener serves the site and that the chat is wired in. No model call, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, chmodSync, renameSync, readFileSync, rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ROOT} from './helpers/archive.mjs';
import {LOCK_FAILED, machineCheck, zoneCheck} from '../local/server.mjs';

const indonesian = (() => { try { zoneCheck(); return !process.env.TZ; } catch { return false; } })();
const skip = !indonesian && 'the machine lock needs an Indonesian system zone and no TZ variable';
const tmp = mkdtempSync(path.join(tmpdir(), 'arsip-startup-'));
test.after(() => rmSync(tmp, {recursive:true, force:true}));

// One tiny archive (tests/helpers/stockbit_fixture.py) and its Worker assets, shared by every start.
function archive(state) {
  execFileSync('python3', ['-B', path.join(ROOT, 'tests/helpers/stockbit_fixture.py'), path.join(tmp, 'fixture')], {cwd:ROOT});
  renameSync(path.join(tmp, 'fixture/site'), path.join(state, 'site'));
  execFileSync('python3', ['-B', 'tools/build_worker.py', '--directory', path.join(state, 'site'), '--out', path.join(state, 'assets')], {cwd:ROOT});
  return JSON.parse(readFileSync(path.join(state, 'assets/manifest.json'), 'utf8')).docs.length;
}
function fakeClaude(name, auth) {
  const file = path.join(tmp, name);
  writeFileSync(file, `#!/bin/sh\ncase "$1" in --version) echo "9.9.9 (Claude Code)";; auth) ${auth};; esac\n`);
  chmodSync(file, 0o755);
  return file;
}
const SUBSCRIPTION = fakeClaude('claude-ok', `echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max"}'`);
const freePort = () => new Promise(ok => { const s = createServer().listen(0, '127.0.0.1', () => { const {port} = s.address(); s.close(() => ok(port)); }); });

// Starts the server; resolves on exit or once `until` appears in stdout.
function start(state, claude, {until = null, args = []} = {}) {
  const {TZ, ARSIP_ALLOW_VPS, CHAT_AGENTIC_DAILY, ...env} = process.env;
  const child = spawn(process.execPath, ['--no-warnings', 'local/server.mjs', ...args],
    {cwd:ROOT, env:{...env, ARSIP_STATE:state, ARSIP_CLAUDE_BIN:claude}});
  let out = '', err = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout:\n' + out + err)); }, 60000);
    child.stdout.on('data', chunk => { out += chunk; if (until && until.test(out)) { clearTimeout(timer); resolve({child, out, err}); } });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('exit', code => { clearTimeout(timer); resolve({code, out, err}); });
  });
}
const stop = child => new Promise(ok => { child.on('exit', ok); child.kill('SIGTERM'); });

test('start-up: lock and login checks, source index import, site on the loopback listener', {skip}, async () => {
  const state = path.join(tmp, 'state');
  execFileSync('mkdir', ['-m', '700', state]);
  // No machine lock yet: stays down (78) before any build.
  let run = await start(state, SUBSCRIPTION);
  assert.equal(run.code, LOCK_FAILED);
  assert.match(run.err, /Mesin belum dikunci/);

  const docs = archive(state);
  machineCheck({pin:true, lockFile:path.join(state, 'machine-lock.json')});
  // Logged in, but not with the Claude subscription: stays down (78).
  run = await start(state, fakeClaude('claude-api', `echo '{"loggedIn":true,"authMethod":"console","apiProvider":"firstParty"}'`));
  assert.equal(run.code, LOCK_FAILED);
  assert.match(run.err, /tidak memakai login langganan/);
  // Status not readable (timeout, an update in progress): exit 1, so systemd retries.
  run = await start(state, fakeClaude('claude-broken', 'exit 3'));
  assert.equal(run.code, 1);
  assert.match(run.err, /Status login Claude Code tidak terbaca/);

  const port = await freePort();
  run = await start(state, SUBSCRIPTION, {args:['--port', String(port)], until:/Arsip berjalan di/});
  try {
    assert.match(run.out, new RegExp(`Indeks sumber: ${docs}/${docs} dokumen baru\\.`));
    assert.match(run.out, new RegExp(`Indeks sumber siap: ${docs}/${docs} dokumen\\.`));
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="arsip-data"/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/%2e%2e/machine-lock.json`)).status, 404);
    // The chat is on (the Claude bridge is wired in); a question answered without a model call streams to "done".
    const config = await (await fetch(`http://127.0.0.1:${port}/api/chat/config`)).json();
    assert.deepEqual([config.ready, config.agentic.limit], [true, 100]);
    const chat = await fetch(`http://127.0.0.1:${port}/api/chat`, {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({question:'SOCI tanggal 17'})});
    assert.equal(chat.status, 200);
    assert.match(await chat.text(), /"type":"done"/);
  } finally { await stop(run.child); }
  // A second start imports nothing new.
  run = await start(state, SUBSCRIPTION, {args:['--port', String(port)], until:/Arsip berjalan di/});
  try {
    assert.doesNotMatch(run.out, /dokumen baru/);
    assert.match(run.out, new RegExp(`Indeks sumber siap: ${docs}/${docs} dokumen\\.`));
  } finally { await stop(run.child); }
});
