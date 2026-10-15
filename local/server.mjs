#!/usr/bin/env node
// Arsip Riset IDX, hosted on this machine: the static viewer plus the archive chat, with the model answered by
// the Claude Code CLI signed in to the owner's Claude account (see local/claude-bridge.mjs). The chat code
// (worker/index.mjs) runs here on Node, with its storage in a local SQLite file.
//
//   node local/server.mjs --pin      first run on this machine: build, record the machine lock, serve
//   node local/server.mjs            later runs (add --build after adding documents)
//   node local/server.mjs --build-only   lock check + build, then exit (used by local/vps.mjs push)
//
// Fail-closed machine lock: the server refuses to start (so no question ever reaches Claude) when it runs in
// a container or virtual machine, when the system time zone is not an Indonesian one, or when the hardware ID
// differs from the one recorded with --pin. The zone is checked again before every model call; a failure stops
// the server. This guards against mistakes (a copied folder, a container started elsewhere); it is not a
// security boundary against the machine's own administrator, and a time zone is not proof of location.
import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, readlinkSync, writeFileSync, mkdirSync, createReadStream, statSync} from 'node:fs';
import {networkInterfaces} from 'node:os';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {claudeFetcher, cliEnv, checkAuth} from './claude-bridge.mjs';
import {storage} from './sqlite-storage.mjs';
import {parseEnv} from './cli.mjs';
import {COOKIE, LOGIN_HEADERS, LoginLimiter, checkPassword, cookies, issueSession, loginPage, validSession} from './remote-auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Machine lock, chat database, built site and assets, remote settings. ARSIP_STATE moves it (tests/server_startup.mjs).
const STATE = process.env.ARSIP_STATE ? path.resolve(process.env.ARSIP_STATE) : path.join(ROOT, '.local');
const SITE = path.join(STATE, 'site'), ASSETS = path.join(STATE, 'assets');
const LOCK = path.join(STATE, 'machine-lock.json');
export const REMOTE = path.join(STATE, 'remote.json');
const INDONESIA = ['Asia/Jakarta', 'Asia/Pontianak', 'Asia/Makassar', 'Asia/Jayapura'];
// Exit status for a failed machine lock or a missing Claude login; the VPS systemd unit does not restart on it
// (RestartPreventExitStatus), so a server that must not run stays down instead of retrying.
export const LOCK_FAILED = 78;
// Agentic questions per UTC day for the whole site (CHAT_AGENTIC_DAILY overrides it); also shown by tools/chat_metrics.py.
export const AGENTIC_DAILY = Number(process.env.CHAT_AGENTIC_DAILY) || 100;
// A Linux VPS (ARSIP_ALLOW_VPS=1) must prove where it runs: Tencent Cloud instance metadata, which the hypervisor
// answers per instance. A disk image copied to another instance or region keeps /etc/machine-id, the lock file and
// the Claude login, but not the instance ID or the region, so it never starts.
const METADATA = 'http://metadata.tencentyun.com/latest/meta-data/';
export const VPS_REGIONS = ['ap-jakarta'];

// `claude -p` model and effort unless --model/--effort or ARSIP_CLAUDE_MODEL/_EFFORT (the VPS: local/vps.mjs setup) say otherwise.
export const MODEL_DEFAULT = 'sonnet', EFFORT_DEFAULT = 'medium';
export function checkModel(model, effort) {
  if (!/^[a-z0-9.\[\]-]+$/i.test(model)) throw new Error('Model tidak valid.');
  if (!['low','medium','high','xhigh','max'].includes(effort)) throw new Error('Effort harus low, medium, high, xhigh, atau max.');
}
export function options(argv, env = process.env) {
  const flags = new Set(['--pin','--repin','--build','--build-only','--allow-lan']), valued = new Set(['--port','--host','--model','--effort','--concurrency']);
  const seen = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flags.has(arg)) seen[arg] = true;
    else if (valued.has(arg)) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error('Opsi ' + arg + ' perlu nilai.');
      seen[arg] = argv[++i];
    } else throw new Error('Opsi tidak dikenal: ' + arg);
  }
  const opt = {pin:!!(seen['--pin'] || seen['--repin']), repin:!!seen['--repin'], allowLan:!!seen['--allow-lan'],
    build:!!(seen['--build'] || seen['--build-only'] || seen['--pin'] || seen['--repin']), buildOnly:!!seen['--build-only'],
    port:Number(seen['--port'] ?? env.ARSIP_PORT ?? 8017), host:seen['--host'] ?? env.ARSIP_HOST ?? '127.0.0.1',
    model:seen['--model'] ?? env.ARSIP_CLAUDE_MODEL ?? MODEL_DEFAULT, effort:seen['--effort'] ?? env.ARSIP_CLAUDE_EFFORT ?? EFFORT_DEFAULT,
    concurrency:Number(seen['--concurrency'] ?? env.ARSIP_CLAUDE_CONCURRENCY ?? 4)};
  if (!Number.isSafeInteger(opt.port) || opt.port < 1 || opt.port > 65535) throw new Error('Port tidak valid.');
  if (!Number.isSafeInteger(opt.concurrency) || opt.concurrency < 1 || opt.concurrency > 8) throw new Error('--concurrency harus 1 sampai 8.');
  checkModel(opt.model, opt.effort);
  return opt;
}

// ---- machine lock -------------------------------------------------------------------------------------
function machineId() {
  if (process.platform === 'darwin') {
    const out = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {encoding:'utf8'});
    return out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] || null;
  }
  for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id'])
    if (existsSync(file)) { const id = readFileSync(file, 'utf8').trim(); if (id) return id; }
  return null;
}
// The system zone (/etc/localtime), not the process one: a TZ variable cannot make another region pass.
export function systemZone() {
  if (process.env.TZ) return 'TZ=' + process.env.TZ;
  try { return readlinkSync('/etc/localtime').match(/zoneinfo\/(.+)$/)?.[1] || null; } catch { return null; }
}
function virtualMachine() {
  if (process.platform === 'darwin') {
    try { return execFileSync('/usr/sbin/sysctl', ['-n', 'kern.hv_vmm_present'], {encoding:'utf8'}).trim() === '1'; } catch { return true; }
  }
  try { return /hypervisor/.test(readFileSync('/proc/cpuinfo', 'utf8')) && !process.env.ARSIP_ALLOW_VPS; } catch { return false; }
}
const containerised = () => ['/.dockerenv', '/run/.containerenv'].some(existsSync) || !!process.env.KUBERNETES_SERVICE_HOST
  || (process.platform === 'linux' && (() => { try { return /docker|containerd|kubepods|lxc/.test(readFileSync('/proc/1/cgroup', 'utf8')); } catch { return false; } })());
export function zoneCheck(timeZone = systemZone()) {
  if (!INDONESIA.includes(timeZone)) throw new Error('Zona waktu sistem ' + timeZone + ' bukan zona Indonesia (' + INDONESIA.join(', ') + ').');
  return timeZone;
}
export async function cloudIdentity(get = fetch) {
  const read = async key => {
    const response = await get(METADATA + key, {signal:AbortSignal.timeout(3000)});
    const value = response.ok ? (await response.text()).trim() : '';
    if (!/^[a-z0-9-]{3,64}$/.test(value)) throw new Error('metadata ' + key + ' tidak valid');
    return value;
  };
  try { return {region:await read('placement/region'), instance:await read('instance-id')}; }
  catch (error) { throw new Error('Identitas instance VPS tidak terbaca (' + error.message + '). Server tidak dijalankan.'); }
}
export function machineCheck({pin = false, repin = false, lockFile = LOCK, id = machineId(), timeZone = systemZone(),
  container = containerised(), vm = virtualMachine(), vps = !!process.env.ARSIP_ALLOW_VPS, cloud = null} = {}) {
  if (container) throw new Error('Berjalan di dalam container. Container dapat dibuat ulang di host/region lain, jadi server tidak dijalankan.');
  if (vm) throw new Error('Berjalan di mesin virtual. Server tidak dijalankan (VPS Linux yang tetap: set ARSIP_ALLOW_VPS=1).');
  zoneCheck(timeZone);
  if (!id) throw new Error('ID mesin tidak terbaca. Server tidak dijalankan.');
  if (vps && !cloud) throw new Error('Identitas instance VPS tidak ada. Server tidak dijalankan.');
  if (cloud && !VPS_REGIONS.includes(cloud.region))
    throw new Error('Region VPS ' + cloud.region + ' bukan ' + VPS_REGIONS.join(', ') + '. Server tidak dijalankan.');
  const digest = createHash('sha256').update('arsip-machine-v1:' + id + (cloud ? '|instance:' + cloud.instance : '')).digest('hex');
  if (pin) {
    let existing = null;
    try { existing = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { /* no lock yet */ }
    if (existing?.machine && existing.machine !== digest && !repin)
      throw new Error('Folder ini dikunci untuk mesin lain. Kalau memang pindah mesin, jalankan dengan --repin.');
    mkdirSync(path.dirname(lockFile), {recursive:true, mode:0o700});
    writeFileSync(lockFile, JSON.stringify({version:1, machine:digest, time_zone:timeZone, ...(cloud ? {region:cloud.region} : {}),
      pinned:new Date().toISOString()}, null, 2) + '\n', {mode:0o600});
    return {pinned:true, timeZone};
  }
  let lock;
  try { lock = JSON.parse(readFileSync(lockFile, 'utf8')); } catch { throw new Error('Mesin belum dikunci. Jalankan sekali: node local/server.mjs --pin'); }
  if (lock.version !== 1 || lock.machine !== digest)
    throw new Error('ID mesin berbeda dari yang dikunci. Server tidak dijalankan. Kalau ini memang mesin baru yang sah, jalankan dengan --pin.');
  return {pinned:false, timeZone};
}

const TYPES = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.md':'text/plain; charset=utf-8', '.csv':'text/plain; charset=utf-8',
  '.txt':'text/plain; charset=utf-8', '.xml':'application/xml; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png',
  '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.ico':'image/x-icon', '.pdf':'application/pdf'};
// Resolves a URL path inside a directory; null for anything that escapes it.
export function inside(directory, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const file = path.resolve(directory, '.' + path.posix.normalize('/' + decoded));
  return file === directory || file.startsWith(directory + path.sep) ? file : null;
}

// Remote access settings written by `node local/remote.mjs setup`; absent means local only.
export function readRemote(file = REMOTE) {
  if (!existsSync(file)) return null;
  const remote = JSON.parse(readFileSync(file, 'utf8'));
  if (remote.version !== 1 || !/^[a-z0-9.-]+$/.test(remote.domain || '') || !Number.isSafeInteger(remote.local_port)
      || !/^[0-9a-f]{64}$/.test(remote.secret || '') || !remote.password?.hash)
    throw new Error('.local/remote.json tidak valid. Jalankan ulang: node local/remote.mjs setup');
  if ((statSync(file).mode & 0o077) !== 0) throw new Error('.local/remote.json harus izin 600.');
  return remote;
}

function build() {
  const run = (args, env = {}) => {
    console.log('$ python3 ' + args.join(' '));
    const result = spawnSync('python3', args, {cwd:ROOT, stdio:'inherit', env:{...process.env, ...env}});
    if (result.status !== 0) throw new Error('Build gagal: python3 ' + args.join(' '));
  };
  mkdirSync(STATE, {recursive:true, mode:0o700});
  // Same origin as this server: the chat API is /api/chat on the same host and port.
  run(['-B', 'build.py', '--out', SITE], {CHAT_API_URL:'/api/chat', BASE_URL:''});
  run(['-B', 'tools/build_worker.py', '--directory', SITE, '--out', ASSETS]);
}

async function main() {
  const opt = options(process.argv.slice(2));
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(opt.host);
  if (!loopback && !opt.allowLan) throw new Error('Server hanya untuk mesin ini (127.0.0.1). Pakai --allow-lan untuk membuka ke jaringan lokal; tidak ada login.');
  let lock;
  try { lock = machineCheck({pin:opt.pin, repin:opt.repin, cloud:process.env.ARSIP_ALLOW_VPS ? await cloudIdentity() : null}); }
  catch (error) { console.error('Gagal: ' + error.message); process.exit(LOCK_FAILED); }
  console.log(lock.pinned ? 'Mesin dikunci (' + lock.timeZone + '): ' + LOCK : 'Kunci mesin cocok (' + lock.timeZone + ').');
  if (opt.build || !existsSync(path.join(SITE, 'index.html')) || !existsSync(path.join(ASSETS, 'manifest.json'))) build();
  if (opt.buildOnly) return;

  // The same clean environment the bridge gives every call: only the stored `claude auth login` counts.
  const claude = process.env.ARSIP_CLAUDE_BIN || 'claude';
  const probe = spawnSync(claude, ['--version'], {encoding:'utf8', env:cliEnv()});
  if (probe.status !== 0) throw new Error('Claude Code CLI tidak ditemukan (' + claude + '). Pasang dan login dulu: claude auth login');
  const authRun = spawnSync(claude, ['auth', 'status', '--json'], {encoding:'utf8', env:cliEnv(), timeout:30000});
  let authStatus;
  try { authStatus = JSON.parse(authRun.stdout); }
  catch { // Timeout, signal, an update in progress: not a verdict on the login, so systemd may retry (exit 1).
    const why = authRun.error ? authRun.error.code || authRun.error.message : authRun.signal ? 'sinyal ' + authRun.signal : 'exit ' + authRun.status;
    throw new Error('Status login Claude Code tidak terbaca (' + why + ').');
  }
  let auth;
  try { auth = checkAuth(authStatus); }
  catch (error) { // Logged out or not the subscription: stays down (no systemd restart) until the owner logs in again.
    console.error('Gagal: ' + error.message);
    process.exit(LOCK_FAILED);
  }
  console.log('Claude Code ' + probe.stdout.trim() + ', login ' + auth.method + ' (' + auth.subscription + '), model ' + opt.model
    + ', effort ' + opt.effort + ', maks ' + opt.concurrency + ' proses.');

  const envFile = path.join(ROOT, '.env.chat'), secrets = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  const {storage:store} = storage(path.join(STATE, 'chat.sqlite'));
  // Addresses this server answers to; the browser's Origin and Host must be one of them (DNS rebinding, CSRF).
  const hostOf = address => address.includes(':') ? '[' + address + ']' : address;
  const addresses = ['127.0.0.1', 'localhost', '::1', ...(loopback ? [] : ['0.0.0.0', '::'].includes(opt.host)
    ? Object.values(networkInterfaces()).flat().filter(n => n && !n.internal).map(n => n.address) : [opt.host])];
  const hosts = new Set(addresses.map(a => hostOf(a) + ':' + opt.port));
  const remote = readRemote();
  // On a VPS every request goes through the password gate: no unauthenticated loopback listener.
  const vps = !!process.env.ARSIP_ALLOW_VPS;
  if (vps && !remote) throw new Error('.local/remote.json tidak ada; di VPS hanya listener bersandi yang dijalankan.');
  const origins = [...[...hosts].map(h => 'http://' + h), ...(remote ? ['https://' + remote.domain] : [])];
  let server, remoteServer, stopping = false;
  const stop = (reason, code = 0) => {
    if (stopping) return; stopping = true;
    console.log('\n' + (reason || 'Berhenti.'));
    env.MODEL_FETCHER?.closeAll?.();
    for (const s of [server, remoteServer]) { s?.close(); s?.closeAllConnections?.(); }
    setTimeout(() => process.exit(code), 500).unref();
  };
  // Re-checked before every model call: a zone change (travel, VPN tooling, changed settings) stops the server.
  const guard = () => {
    try { zoneCheck(); }
    catch (error) { setImmediate(() => stop('Pemeriksaan mesin gagal: ' + error.message + ' Server dimatikan.', LOCK_FAILED)); throw error; }
  };
  const env = {
    // Placeholder that marks the chat as enabled; the bridge never sends it anywhere.
    OPENROUTER_API_KEY:'local-claude-code',
    MODEL_FETCHER:claudeFetcher({bin:claude, model:opt.model, effort:opt.effort, concurrency:opt.concurrency, guard,
      keyFile:path.join(STATE, 'boundary.key'),
      log:entry => console.log('[claude]', JSON.stringify(entry))}),
    MODEL_LABEL:'claude-code:' + opt.model,
    CHAT_ALLOWED_ORIGINS:origins.join(','),
    // Each analysis runs at most two model calls at once, so the analyses admitted never outnumber CLI slots.
    CHAT_DAILY_REQUESTS:'3000', CHAT_HOURLY_PER_IP:'300',
    CHAT_CONCURRENT_REQUESTS:String(Math.max(1, Math.floor(opt.concurrency / 2))), CHAT_CONCURRENT_PER_IP:String(Math.max(1, Math.floor(opt.concurrency / 2))),
    CHAT_AGENTIC_DAILY:String(AGENTIC_DAILY), CHAT_DAILY_OUTPUT_TOKENS:'3000000', CHAT_DAILY_BYTES:'300000000',
    ...(secrets.DATACAT_API_KEY ? {DATACAT_API_KEY:secrets.DATACAT_API_KEY} : {}),
    ...(secrets.CHAT_METRICS_TOKEN ? {CHAT_METRICS_TOKEN:secrets.CHAT_METRICS_TOKEN} : {}),
    ASSETS:{async fetch(request) {
      const file = inside(ASSETS, new URL(request.url).pathname);
      if (!file) return new Response('Not found', {status:404});
      try { return new Response(await readFile(file)); } catch { return new Response('Not found', {status:404}); }
    }},
  };
  const {default: worker, ArchiveChat} = await import('../worker/index.mjs');
  const pending = new Set();
  const object = new ArchiveChat({storage:store, waitUntil:promise => { pending.add(promise); promise.finally(() => pending.delete(promise)).catch(() => {}); }}, env);
  env.CHAT = {idFromName:name => name, get:() => ({fetch:request => object.fetch(request)})};

  // Persistent source index, filled in-process and without AI.
  const index = await object.archive.manifest();
  await object.sources.importPending(index, doc => object.archive.read(doc.evidence_asset), (n, total) => {
    if (n % 10 === 0 || n === total) console.log(`Indeks sumber: ${n}/${total} dokumen baru.`);
  });
  // After the import: rows of other versions go only once this version is complete (prune defers itself otherwise),
  // so a push that fails half way and the rollback to app.old keep both versions' progress.
  const pruned = object.sources.prune(index);
  if (pruned.removed) console.log(`Indeks sumber: ${pruned.removed} dokumen versi lama dihapus (${pruned.records} bagian).`);
  console.log(`Indeks sumber siap: ${object.sources.status(index).ready}/${index.docs.length} dokumen.`);
  if (!env.DATACAT_API_KEY) console.log('Mode agen nonaktif: DATACAT_API_KEY tidak ada di .env.chat.');

  if (!vps) {
    server = createServer(handler({worker, env, hosts, client:req => req.socket.remoteAddress || 'local'}));
    server.listen(opt.port, opt.host, () => console.log(`\nArsip berjalan di http://${opt.host === '::1' ? '[::1]' : opt.host}:${opt.port}  (Ctrl+C untuk berhenti)`));
  }
  if (remote) {
    // Reached only through Caddy: on the VPS itself (local/vps.mjs), or through the SSH tunnel from the VPS
    // (local/remote.mjs). Caddy appends the device's address to X-Forwarded-For, so the last entry is the client.
    const forwarded = req => String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || 'remote';
    remoteServer = createServer(handler({worker, env, hosts:new Set([remote.domain]), client:forwarded, auth:gate(remote, forwarded)}));
    remoteServer.listen(remote.local_port, '127.0.0.1', () => console.log(`Akses jarak jauh: https://${remote.domain} (${remote.vps_host ? 'lewat VPS ' + remote.vps_host : 'Caddy di mesin ini'}, sandi wajib)`));
  }
  process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
}

const SECURITY = {'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer', 'X-Frame-Options':'SAMEORIGIN'};
const plain = (res, status, text, extra = {}) => { res.writeHead(status, {'Content-Type':'text/plain; charset=utf-8', ...SECURITY, ...extra}); res.end(text); };

// Remote password gate. Returns true when the request may continue; otherwise it has answered the request.
export function gate(remote, client, limiter = new LoginLimiter()) {
  return async (req, res, url) => {
    const signed = validSession(remote.secret, cookies(req.headers.cookie)[COOKIE]);
    if (url.pathname === '/keluar') {
      res.writeHead(303, {Location:'/masuk', 'Set-Cookie':COOKIE + '=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0', ...SECURITY});
      res.end(); return false;
    }
    if (url.pathname === '/masuk' && req.method === 'POST') {
      const who = client(req);
      // Same-origin form posts only (login CSRF); the cookie is SameSite=Strict as well. The login page asks for
      // Referrer-Policy same-origin so the browser sends its Origin; a browser that still sends "null" for a form
      // navigation is accepted only when it marks the request same-origin (Sec-Fetch-Site, set by the browser).
      const origin = req.headers.origin;
      const sameOrigin = origin === 'https://' + remote.domain
        || (origin === 'null' && req.headers['sec-fetch-site'] === 'same-origin' && req.headers['sec-fetch-mode'] === 'navigate');
      if (!sameOrigin) { plain(res, 403, 'Origin tidak diizinkan'); return false; }
      if (limiter.blocked(who)) { res.writeHead(429, {...SECURITY, ...LOGIN_HEADERS}); res.end(loginPage('Terlalu banyak percobaan. Coba lagi nanti.')); return false; }
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 1024) { plain(res, 413, 'Terlalu besar'); return false; } }
      const password = new URLSearchParams(body).get('sandi') || '';
      if (!checkPassword(password, remote.password)) {
        limiter.fail(who);
        console.log('[remote] login gagal dari ' + who);
        res.writeHead(401, {...SECURITY, ...LOGIN_HEADERS}); res.end(loginPage('Kata sandi salah.')); return false;
      }
      const session = issueSession(remote.secret);
      res.writeHead(303, {Location:'/', 'Set-Cookie':`${COOKIE}=${session.value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${session.maxAge}`, ...SECURITY});
      res.end(); return false;
    }
    if (signed) {
      if (url.pathname === '/masuk') { res.writeHead(303, {Location:'/', ...SECURITY}); res.end(); return false; }
      return true;
    }
    if (url.pathname.startsWith('/api/')) { plain(res, 401, 'Perlu masuk'); return false; }
    if (url.pathname === '/masuk' && req.method === 'GET') { res.writeHead(200, {...SECURITY, ...LOGIN_HEADERS}); res.end(loginPage()); return false; }
    res.writeHead(303, {Location:'/masuk', ...SECURITY}); res.end(); return false;
  };
}

function handler({worker, env, hosts, client, auth = null}) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const security = SECURITY;
    if (!hosts.has(String(req.headers.host || '').toLowerCase())) return plain(res, 421, 'Host tidak dikenal');
    try {
      if (auth && !await auth(req, res, url)) return;
      if (url.pathname === '/api/chat' || url.pathname.startsWith('/api/chat/')) {
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableFinished) controller.abort(); });
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers))
          if (!/^(cf-connecting-ip|x-forwarded-for|host|connection|transfer-encoding|cookie)$/i.test(key)) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        // The client address comes from the socket (or the VPS proxy); a client cannot pick its own rate-limit identity.
        headers.set('CF-Connecting-IP', client(req));
        const hasBody = !['GET', 'HEAD'].includes(req.method);
        const request = new Request('http://' + req.headers.host + url.pathname + url.search, {method:req.method, headers,
          signal:controller.signal, ...(hasBody ? {body:Readable.toWeb(req), duplex:'half'} : {})});
        const response = await worker.fetch(request, env);
        res.writeHead(response.status, {...Object.fromEntries(response.headers), ...security});
        if (!response.body) return res.end();
        const reader = response.body.getReader();
        res.on('close', () => reader.cancel().catch(() => {}));
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          if (!res.write(value)) await new Promise(ok => res.once('drain', ok).once('close', ok));
        }
        return res.end();
      }
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, security); return res.end(); }
      let file = inside(SITE, url.pathname);
      if (file && existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!file || !existsSync(file) || !statSync(file).isFile()) return plain(res, 404, 'Tidak ditemukan');
      res.writeHead(200, {'Content-Type':TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length':statSync(file).size, 'Cache-Control':auth ? 'private, no-cache' : 'no-cache', ...security});
      if (req.method === 'HEAD') return res.end();
      createReadStream(file).pipe(res);
    } catch (error) {
      console.error('Request gagal:', error.name, error.message);
      if (!res.headersSent) res.writeHead(500, {'Content-Type':'text/plain; charset=utf-8', ...security});
      res.end();
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error('Gagal: ' + error.message); process.exit(1); });
