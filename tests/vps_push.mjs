// local/vps.mjs push, the shell steps run with sh on a temp folder laid out like /srv/arsip: the new copy inherits the
// machine lock and the prompt-cache boundary key, is built (pinned on the first push), swapped in with the chat
// database, and restored when the new server does not start.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, symlinkSync, rmSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildScript, carryState, pushable, restoreScript, swapScript} from '../local/vps.mjs';

const sh = (dir, script) => execFileSync('sh', ['-c', 'set -e; ' + script], {cwd:dir, encoding:'utf8'});
const run = dir => sh(dir, carryState());
const KEY = 'ab'.repeat(32) + '\n';

function srv() {
  const dir = mkdtempSync(path.join(tmpdir(), 'arsip-carry-'));
  mkdirSync(path.join(dir, 'app', '.local'), {recursive:true, mode:0o700});
  mkdirSync(path.join(dir, 'app.new'), {mode:0o700});
  return dir;
}

test('push carries machine-lock.json and boundary.key (mode 600) into app.new, leaving app untouched', () => {
  const dir = srv();
  try {
    writeFileSync(path.join(dir, 'app/.local/machine-lock.json'), '{"lock":1}\n', {mode:0o600});
    writeFileSync(path.join(dir, 'app/.local/boundary.key'), KEY, {mode:0o644});
    writeFileSync(path.join(dir, 'app/.local/chat.sqlite'), 'db');
    run(dir);
    assert.equal(readFileSync(path.join(dir, 'app.new/.local/boundary.key'), 'utf8'), KEY);
    assert.equal(statSync(path.join(dir, 'app.new/.local/boundary.key')).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(dir, 'app.new/.local')).mode & 0o777, 0o700);
    assert.equal(readFileSync(path.join(dir, 'app.new/.local/machine-lock.json'), 'utf8'), '{"lock":1}\n');
    assert.ok(!existsSync(path.join(dir, 'app.new/.local/boundary.key.tmp')));
    // The database is moved later by the swap step, not copied here; the old copy keeps its files for rollback.
    assert.ok(!existsSync(path.join(dir, 'app.new/.local/chat.sqlite')));
    assert.equal(readFileSync(path.join(dir, 'app/.local/boundary.key'), 'utf8'), KEY);
    assert.ok(existsSync(path.join(dir, 'app/.local/machine-lock.json')));
    run(dir); // idempotent
    assert.equal(readFileSync(path.join(dir, 'app.new/.local/boundary.key'), 'utf8'), KEY);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('first push (no key, no lock) and a symlinked key copy nothing; the new server makes its own', () => {
  const dir = srv();
  try {
    run(dir);
    assert.ok(existsSync(path.join(dir, 'app.new/.local')));
    assert.ok(!existsSync(path.join(dir, 'app.new/.local/boundary.key')));
    assert.ok(!existsSync(path.join(dir, 'app.new/.local/machine-lock.json')), 'missing lock still means --pin');
    writeFileSync(path.join(dir, 'secret'), KEY);
    symlinkSync(path.join(dir, 'secret'), path.join(dir, 'app/.local/boundary.key'));
    run(dir);
    assert.ok(!existsSync(path.join(dir, 'app.new/.local/boundary.key')));
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('an empty or malformed boundary.key is not carried (the new server writes a valid one)', () => {
  const dir = srv();
  try {
    for (const bad of ['', 'xyz\n', 'ab'.repeat(31) + '\n']) {
      writeFileSync(path.join(dir, 'app/.local/boundary.key'), bad, {mode:0o600});
      rmSync(path.join(dir, 'app.new/.local'), {recursive:true, force:true});
      run(dir);
      assert.ok(!existsSync(path.join(dir, 'app.new/.local/boundary.key')), JSON.stringify(bad));
    }
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('the Mac\'s own .local/boundary.key is never uploaded', () => {
  assert.deepEqual(pushable(['.local/boundary.key', '.local/machine-lock.json', 'local/claude-bridge.mjs']), ['local/claude-bridge.mjs']);
});

const write = (dir, file, text) => { mkdirSync(path.dirname(path.join(dir, file)), {recursive:true}); writeFileSync(path.join(dir, file), text); };
const read = (dir, file) => readFileSync(path.join(dir, file), 'utf8');
const list = (dir, sub) => existsSync(path.join(dir, sub)) ? readdirSync(path.join(dir, sub)).sort() : null;

test('build runs server.mjs --build-only in app.new: --pin only on the first push, --repin on request', () => {
  const dir = srv();
  try {
    // A fake node that records its arguments, the VPS flag and where it ran.
    write(dir, 'node', '#!/bin/sh\necho "$PWD $ARSIP_ALLOW_VPS $*" >> ../calls\n');
    chmodSync(path.join(dir, 'node'), 0o755);
    const build = opt => sh(dir, buildScript({node:path.join(dir, 'node'), ...opt}));
    build();
    write(dir, 'app/.local/machine-lock.json', '{"lock":1}\n');
    build();
    build({repin:true});
    const calls = read(dir, 'calls').trim().split('\n').map(line => line.replace(/^\S+\/(app\.new) /, '$1 ').trim());
    assert.deepEqual(calls, ['app.new 1 local/server.mjs --build-only --pin', 'app.new 1 local/server.mjs --build-only',
      'app.new 1 local/server.mjs --build-only --repin']);
    assert.equal(read(dir, 'app.new/.local/machine-lock.json'), '{"lock":1}\n');
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

function deployed() {
  const dir = srv();
  write(dir, 'app/version', 'old'); write(dir, 'app.new/version', 'new');
  for (const f of ['chat.sqlite', 'chat.sqlite-wal', 'chat.sqlite-shm']) write(dir, 'app/.local/' + f, f);
  write(dir, 'app/.env.chat', 'DATACAT_API_KEY=x\n');
  write(dir, 'app.old/version', 'older'); write(dir, 'app.failed/version', 'failed before');
  return dir;
}

test('swap: the database moves to the new copy, .env.chat is copied, the old copy waits as app.old', () => {
  const dir = deployed();
  try {
    sh(dir, swapScript());
    assert.deepEqual(list(dir, '.'), ['app', 'app.old']);
    assert.equal(read(dir, 'app/version'), 'new');
    assert.deepEqual(list(dir, 'app/.local'), ['chat.sqlite', 'chat.sqlite-shm', 'chat.sqlite-wal']);
    assert.equal(read(dir, 'app/.local/chat.sqlite'), 'chat.sqlite');
    assert.equal(read(dir, 'app/.env.chat'), 'DATACAT_API_KEY=x\n');
    assert.equal(read(dir, 'app.old/version'), 'old');
    assert.deepEqual(list(dir, 'app.old/.local'), []);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('restore after a failed start: the database goes back, the old copy is app again, the new one app.failed', () => {
  const dir = deployed();
  try {
    sh(dir, swapScript());
    sh(dir, restoreScript());
    assert.deepEqual(list(dir, '.'), ['app', 'app.failed']);
    assert.equal(read(dir, 'app/version'), 'old');
    assert.deepEqual(list(dir, 'app/.local'), ['chat.sqlite', 'chat.sqlite-shm', 'chat.sqlite-wal']);
    assert.equal(read(dir, 'app.failed/version'), 'new');
    assert.deepEqual(list(dir, 'app.failed/.local'), []);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('restore when the swap never started (no app.old) leaves the running copy alone', () => {
  const dir = srv();
  try {
    write(dir, 'app/version', 'old'); write(dir, 'app/.local/chat.sqlite', 'db'); write(dir, 'app.new/version', 'new');
    sh(dir, restoreScript());
    assert.deepEqual(list(dir, '.'), ['app', 'app.new']);
    assert.equal(read(dir, 'app/.local/chat.sqlite'), 'db');
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
