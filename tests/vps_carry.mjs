// local/vps.mjs push: the new copy inherits the machine lock and the prompt-cache boundary key from the running one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {carryState, pushable} from '../local/vps.mjs';

const run = dir => execFileSync('sh', ['-c', 'set -e; ' + carryState()], {cwd:dir});
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
