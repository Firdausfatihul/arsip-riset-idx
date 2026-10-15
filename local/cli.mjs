// Shared pieces of the local command-line tools (local/vps.mjs, local/remote.mjs, local/server.mjs).
import {existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {newPassword, hashPassword} from './remote-auth.mjs';

// {_: [positional…], option: value, flag: true}; only the names in `flags` take no value.
export function parseArgs(argv, flags = []) {
  const out = {_:[]};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { out._.push(argv[i]); continue; }
    const key = argv[i].slice(2);
    if (flags.includes(key)) { out[key] = true; continue; }
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error('Opsi --' + key + ' perlu nilai.');
    out[key] = argv[++i];
  }
  return out;
}

// Runs commands[first argument](options) when `url` is the script node was started with; an error prints "Gagal: …"
// and exits 1. `flags`: options without a value.
export async function cli(url, flags, commands) {
  if (!process.argv[1] || path.resolve(process.argv[1]) !== fileURLToPath(url)) return;
  try {
    const opt = parseArgs(process.argv.slice(2), flags), run = commands[opt._[0]];
    if (!run) throw new Error('Perintah: ' + Object.keys(commands).join(' | '));
    await run(opt);
  } catch (error) { console.error('Gagal: ' + error.message); process.exit(1); }
}

// Settings in .local/ (JSON, mode 600).
export function readConfig(file, setupCommand) {
  if (!existsSync(file)) throw new Error('Belum di-setup. Jalankan: ' + setupCommand);
  return JSON.parse(readFileSync(file, 'utf8'));
}
export function writeConfig(file, config) {
  mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n', {mode:0o600});
  chmodSync(file, 0o600);
}
// A new device password: its hash and a new session secret go into config (every device signs in again).
export function rotatePassword(config) {
  const password = newPassword();
  config.password = hashPassword(password);
  config.secret = randomBytes(32).toString('hex');
  return password;
}

export const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

// KEY=value lines of an .env file (an `export` prefix and surrounding quotes allowed).
export function parseEnv(text) {
  const values = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}
