#!/usr/bin/env node
// Everything on a Jakarta VPS, Claude included, so this Mac can be off:
//
//   device --HTTPS--> VPS: Caddy --> 127.0.0.1:8018 local/server.mjs (password gate) --> `claude -p`
//
// Claude Code on the VPS is the official CLI, installed with Anthropic's installer for a dedicated `arsip` user and
// signed in with `claude auth login` (the owner's Claude subscription), exactly as the owner would use it in a
// terminal. The server refuses to start unless `claude auth status` shows that login (local/claude-bridge.mjs).
// Run from this Mac; every command goes over SSH to the admin account (sudo) given at setup.
//
//   node local/vps.mjs setup --host <ip> --domain <name> --host-key SHA256:… [--ssh-user ubuntu] [--ssh-port 22] [--new-password]
//                            [--model sonnet|opus|haiku] [--effort low|medium|high]
//   node local/vps.mjs apply       send settings, keys and password to the VPS and restart (no rebuild)
//   node local/vps.mjs bootstrap   root setup: Jakarta time zone, Node, Caddy, user arsip, Claude Code, systemd
//   node local/vps.mjs login       interactive `claude auth login` on the VPS (open the URL on any browser)
//   node local/vps.mjs push        copy code + archive + keys, build, pin the machine (first time), restart
//   node local/vps.mjs status | logs | password
//   node local/vps.mjs metrics [--days 7] [--limit 100] [--offset 0]   question/cost statistics as JSON (tools/chat_metrics.py)
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {existsSync, readFileSync, appendFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {cli, parseEnv, readConfig, rotatePassword, shellQuote as q, writeConfig} from './cli.mjs';
import {validate} from './remote.mjs';
import {AGENTIC_DAILY, EFFORT_DEFAULT, MODEL_DEFAULT, checkModel} from './server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, '.local');
const CONFIG = path.join(STATE, 'vps.json');
const KNOWN = path.join(STATE, 'known_hosts');
export const APP = '/srv/arsip/app', HOME = '/home/arsip', PORT = 8018;
const CLAUDE = HOME + '/.local/bin/claude', NODE = '/opt/arsip/node/bin/node';
const PATH_VPS = `${HOME}/.local/bin:/opt/arsip/node/bin:/usr/local/bin:/usr/bin:/bin`;
// Official Node.js release tarball; checksums from https://nodejs.org/dist/v22.17.1/SHASUMS256.txt
const NODE_VERSION = '22.17.1';
const NODE_SHA = {x64:'ff04bc7c3ed7699ceb708dbaaf3580d899ff8bf67f17114f979e83aa74fc5a49',
  arm64:'a5bb879af2fe70e7b5dc5e0bbadecba88e87f45bd8e62c0c57b5c815a4cbbaa6'};
// Built on the VPS, never copied: published site, reports, tests, and every local secret except the two below.
const SKIP = /^(docs|reports|tests|site|output|removed-from-archive|\.local|\.stockbit-publish)\/|^\.env/;

const read = () => {
  const config = readConfig(CONFIG, 'node local/vps.mjs setup --host <ip> --domain <nama>');
  validate({vps:config.host, domain:config.domain, sshPort:config.ssh_port, sshUser:config.ssh_user});
  return config;
};

const sshBase = config => ['-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlgorithms=ssh-ed25519', '-o', 'UserKnownHostsFile=' + KNOWN,
  '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=20', '-p', String(config.ssh_port)];
const target = config => `${config.ssh_user}@${config.host}`;

// The VPS host key must match the fingerprint the owner read in the provider's web console (setup --host-key), not
// one learned over the network: the Claude login code, the archive and the keys then reach only that server.
const HOST_KEY = /^SHA256:[A-Za-z0-9+/]{43}$/;
const knownName = config => config.ssh_port === 22 ? config.host : `[${config.host}]:${config.ssh_port}`;
export const fingerprint = line => (spawnSync('ssh-keygen', ['-lf', '-'], {input:line + '\n', encoding:'utf8'}).stdout || '').split(/\s+/)[1] || '';
let trusted = false;
function trustHost(config) {
  if (trusted) return;
  if (!HOST_KEY.test(config.host_key || '')) throw new Error('Sidik jari host VPS belum dicatat. Di konsol web penyedia (bukan lewat SSH dari Mac) jalankan:\n'
    + '    ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub\nlalu: node local/vps.mjs setup --host-key SHA256:…');
  const known = (spawnSync('ssh-keygen', ['-F', knownName(config), '-f', KNOWN], {encoding:'utf8'}).stdout || '')
    .split('\n').find(line => / ssh-ed25519 /.test(line));
  if (known) {
    if (fingerprint(known) !== config.host_key) throw new Error(`Kunci host di ${KNOWN} tidak cocok dengan sidik jari yang dicatat. Berhenti.`);
  } else {
    const scanned = (spawnSync('ssh-keyscan', ['-t', 'ed25519', '-p', String(config.ssh_port), config.host], {encoding:'utf8'}).stdout || '')
      .split('\n').find(line => / ssh-ed25519 /.test(line));
    if (!scanned || fingerprint(scanned) !== config.host_key) throw new Error('Kunci host VPS tidak cocok dengan sidik jari yang dicatat. Berhenti.');
    mkdirSync(STATE, {recursive:true, mode:0o700});
    appendFileSync(KNOWN, knownName(config) + ' ' + scanned.split(' ').slice(1).join(' ') + '\n', {mode:0o600});
  }
  trusted = true;
}
// Runs a command on the VPS. `input` goes to its stdin; `tty` gives an interactive terminal (login).
function ssh(config, command, {input, tty = false, capture = false} = {}) {
  trustHost(config);
  const r = spawnSync('ssh', [...sshBase(config), ...(tty ? ['-t'] : ['-o', 'BatchMode=yes']), target(config), command],
    {input, encoding:'utf8', stdio:tty ? 'inherit' : [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit']});
  if (r.error) throw r.error;
  return r;
}
const must = (r, what) => { if (r.status !== 0) throw new Error(what + ' gagal (exit ' + r.status + ').'); return r; };
// Runs as the server user with a login-shell environment, as if the owner typed it in a terminal on the VPS.
const asArsip = command => `sudo -iu arsip ${command}`;

// Only the keys the server uses; anything else in .env.chat stays on this Mac.
export const serverSecrets = text => Object.entries(parseEnv(text))
  .filter(([k, v]) => ['DATACAT_API_KEY', 'CHAT_METRICS_TOKEN'].includes(k) && /^[\x21-\x7e]+$/.test(v)).map(([k, v]) => `${k}=${v}\n`).join('');
export const pushable = files => files.filter(f => f && !SKIP.test(f) && !f.split('/').includes('__pycache__'));

// Root script for a fresh Ubuntu 24.04 / Debian 12 VPS, piped to `sudo bash -s`. Idempotent.
export function bootstrapScript({domain, claudeVersion}) {
  if (!/^\d+\.\d+\.\d+$/.test(claudeVersion || '')) throw new Error('Versi Claude Code tidak valid: ' + claudeVersion);
  return `#!/usr/bin/env bash
# Arsip Riset IDX: server lengkap di VPS Jakarta (situs + chat + Claude Code). Dijalankan sebagai root.
set -euo pipefail
DOMAIN=${q(domain)}
[ "$(id -u)" = 0 ] || { echo "Jalankan sebagai root."; exit 1; }
# The server's lock accepts only an Indonesian system time zone.
timedatectl set-timezone Asia/Jakarta
apt-get update -qq
apt-cache show caddy >/dev/null 2>&1 || { echo "Paket caddy tidak ada. Pakai Ubuntu 24.04 atau Debian 12."; exit 1; }
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy python3 curl tar xz-utils ca-certificates

# Node.js ${NODE_VERSION} (node:sqlite, module hooks), official tarball, checksum pinned.
case "$(uname -m)" in
  x86_64) ARCH=x64; SHA=${NODE_SHA.x64} ;;
  aarch64) ARCH=arm64; SHA=${NODE_SHA.arm64} ;;
  *) echo "Arsitektur $(uname -m) tidak didukung."; exit 1 ;;
esac
if [ "$(${NODE} --version 2>/dev/null || true)" != "v${NODE_VERSION}" ]; then
  TMP=$(mktemp -d)
  curl -fsSL -o "$TMP/node.tar.xz" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-$ARCH.tar.xz"
  echo "$SHA  $TMP/node.tar.xz" | sha256sum -c --quiet -
  rm -rf /opt/arsip/node && mkdir -p /opt/arsip/node
  tar -xJf "$TMP/node.tar.xz" -C /opt/arsip/node --strip-components=1 --no-same-owner
  rm -rf "$TMP"
fi

# Server user: locked password, no SSH key. Reached only with sudo from the admin account.
id arsip >/dev/null 2>&1 || useradd --create-home --home-dir ${HOME} --shell /bin/bash arsip
passwd -l arsip >/dev/null
chmod 700 ${HOME}
# Root never follows paths inside trees the service user owns (it could plant symlinks): /srv/arsip is created
# once by root in root-owned /srv, everything below it by arsip.
if [ -L /srv/arsip ]; then echo "/srv/arsip adalah symlink; berhenti."; exit 1; fi
[ -d /srv/arsip ] || install -d -m 700 -o arsip -g arsip /srv/arsip
runuser -u arsip -- mkdir -p -m 700 ${APP}
# 2 GB RAM: swap so a burst of answers slows down instead of being killed.
if [ -z "$(swapon --show --noheadings)" ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Claude Code with Anthropic's installer, as the server user, same version as the owner's Mac.
sudo -iu arsip bash -c 'curl -fsSL https://claude.ai/install.sh | bash -s ${claudeVersion}'
sudo -iu arsip ${CLAUDE} --version
# As after a normal install: \`claude\` on the user's PATH in a login shell (written by arsip itself).
runuser -l arsip -c 'grep -qs ".local/bin" "$HOME/.profile" || echo "export PATH=\\"\\$HOME/.local/bin:\\$PATH\\"" >> "$HOME/.profile"'

cat > /etc/systemd/system/arsip.service <<'EOF'
[Unit]
Description=Arsip Riset IDX (situs + chat via Claude Code)
After=network-online.target
Wants=network-online.target

[Service]
User=arsip
Group=arsip
WorkingDirectory=${APP}
Environment=PATH=${PATH_VPS}
Environment=ARSIP_ALLOW_VPS=1
Environment=LANG=C.UTF-8
# Model and effort chosen with setup --model/--effort, written by push (ARSIP_CLAUDE_MODEL, ARSIP_CLAUDE_EFFORT).
EnvironmentFile=-${APP}/.local/server.env
ExecStart=${NODE} local/server.mjs
Restart=on-failure
RestartSec=10
# 78: machine lock or Claude login failed. Stay down instead of retrying.
RestartPreventExitStatus=78
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/srv/arsip ${HOME}
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable arsip >/dev/null
# Started by "push" once the archive and the Claude login are in place.

# HTTPS (Let's Encrypt) in front of the password-gated listener. The chat streams NDJSON: flush immediately.
[ -f /etc/caddy/Caddyfile ] && cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%Y%m%d%H%M%S)"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	header Strict-Transport-Security "max-age=31536000"
	header -Server
	reverse_proxy 127.0.0.1:${PORT} {
		flush_interval -1
	}
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable --now caddy
systemctl reload caddy
echo
echo "Zona waktu: $(timedatectl show -p Timezone --value)   Node: $(${NODE} --version)"
free -m | head -3
echo "Selesai. Berikutnya di Mac: node local/vps.mjs login, lalu node local/vps.mjs push"
`;
}

function claudeVersion() {
  const out = execFileSync(process.env.ARSIP_CLAUDE_BIN || 'claude', ['--version'], {encoding:'utf8'});
  const m = out.match(/\d+\.\d+\.\d+/);
  if (!m) throw new Error('Versi Claude Code di Mac tidak terbaca.');
  return m[0];
}

function setup(opt) {
  const old = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : null;
  const config = {version:1, host:opt.host || old?.host, domain:(opt.domain || old?.domain || '').toLowerCase(),
    ssh_user:opt['ssh-user'] || old?.ssh_user || 'ubuntu', ssh_port:Number(opt['ssh-port'] || old?.ssh_port || 22),
    host_key:opt['host-key'] || old?.host_key, model:opt.model || old?.model || MODEL_DEFAULT, effort:opt.effort || old?.effort || EFFORT_DEFAULT,
    secret:old?.secret, password:old?.password};
  serverEnv(config);
  validate({vps:config.host, domain:config.domain, sshPort:config.ssh_port, sshUser:config.ssh_user});
  if (config.host_key && !HOST_KEY.test(config.host_key)) throw new Error('--host-key harus SHA256:… (43 karakter), dari ssh-keygen -lf di konsol VPS.');
  const password = !config.password || opt['new-password'] ? rotatePassword(config) : null;
  writeConfig(CONFIG, config);
  console.log('Pengaturan tersimpan: ' + CONFIG);
  if (password) console.log(`\nKATA SANDI untuk semua perangkat (simpan di pengelola sandi; tidak ditampilkan lagi):\n\n    ${password}\n`);
  console.log(`Langkah berikutnya:
  1. DNS: A record  ${config.domain}  ->  ${config.host}
  2. ${config.host_key ? 'Sidik jari host tercatat: ' + config.host_key : 'Konsol web VPS: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub, lalu setup --host-key SHA256:…'}
  3. node local/vps.mjs bootstrap
  4. node local/vps.mjs login      (interaktif: buka URL di browser, tempel kodenya)
  5. node local/vps.mjs push`);
}

function bootstrap(opt) {
  const config = read();
  const version = opt['claude-version'] || claudeVersion();
  console.log(`Menyiapkan ${config.host} (Claude Code ${version}, Node ${NODE_VERSION}, domain ${config.domain})…`);
  must(ssh(config, 'sudo -n bash -s', {input:bootstrapScript({domain:config.domain, claudeVersion:version})}), 'Bootstrap VPS');
}

// The JSON object in the output (a login shell may print other lines first).
const jsonIn = text => { try { return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { return null; } };
function vpsAuth(config) {
  return jsonIn(ssh(config, asArsip(`${CLAUDE} auth status --json`), {capture:true}).stdout || '');
}
function macAuth() {
  try { return JSON.parse(execFileSync(process.env.ARSIP_CLAUDE_BIN || 'claude', ['auth', 'status', '--json'], {encoding:'utf8'})); } catch { return null; }
}
// Same account as the owner's Mac? Prints both so a login with the wrong account is noticed.
function compareAccounts(vps) {
  const mac = macAuth();
  const who = a => a ? `${a.email || '?'} (${a.authMethod}, ${a.subscriptionType || '?'})` : 'tidak terbaca';
  console.log('Login Claude di VPS: ' + (vps?.loggedIn ? who(vps) : 'belum login'));
  console.log('Login Claude di Mac: ' + (mac?.loggedIn ? who(mac) : 'belum login'));
  if (vps?.loggedIn && mac?.loggedIn && (vps.email !== mac.email || vps.orgId !== mac.orgId))
    console.log('PERINGATAN: akun/organisasi VPS berbeda dari Mac. Jalankan ulang: node local/vps.mjs login');
}

function login() {
  const config = read();
  console.log('Login Claude Code di VPS sebagai user arsip. Buka URL yang muncul di browser mana pun, masuk dengan akun Claude, lalu tempel kodenya di sini.\n');
  ssh(config, asArsip(`${CLAUDE} auth login --claudeai`), {tty:true});
  compareAccounts(vpsAuth(config));
}

// Sends the tracked and new (not ignored) files as one tar stream into a fresh folder next to the app; the
// server keeps running meanwhile. Unpacked as the server user, so nothing in the app is root-owned.
function upload(config, files) {
  trustHost(config);
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-czf', '-', '--no-xattrs', '--no-mac-metadata', '--null', '-T', '-'],
      {cwd:ROOT, env:{...process.env, COPYFILE_DISABLE:'1'}, stdio:['pipe', 'pipe', 'inherit']});
    const remote = spawn('ssh', [...sshBase(config), '-o', 'BatchMode=yes', target(config), `sudo -u arsip sh -c ${q(
      `set -e; cd /srv/arsip; rm -rf app.new; mkdir -m 700 app.new; tar -xzf - -C app.new --no-same-owner --no-same-permissions`)}`],
      {stdio:['pipe', 'inherit', 'inherit']});
    tar.stdout.pipe(remote.stdin);
    tar.stdin.end(files.join('\0'));
    let tarCode = null;
    tar.on('close', code => { tarCode = code; });
    tar.on('error', reject); remote.on('error', reject);
    remote.on('close', code => code === 0 && tarCode === 0 ? resolve() : reject(new Error(`Upload gagal (tar ${tarCode}, ssh ${code}).`)));
  });
}

// State the new copy inherits from the running one before it is built (run in /srv/arsip). The machine lock is copied as
// before (a missing lock means the first push, which pins). The prompt-cache boundary key (local/claude-bridge.mjs) is
// copied with mode 600 so a deploy keeps Claude's cached prefixes warm; a symlink, a missing key or one without a valid
// 64-hex key line is not copied, and
// the new server then makes its own. Copies, not moves: a failed swap leaves app (later app.old) exactly as it was.
// The Mac's own .local/ is never uploaded (SKIP), so these only ever come from the VPS.
export function carryState(from = 'app', to = 'app.new') {
  return `mkdir -p -m 700 ${to}/.local; if [ -f ${from}/.local/machine-lock.json ]; then cp -p ${from}/.local/machine-lock.json ${to}/.local/; fi; `
    + `if [ -f ${from}/.local/boundary.key ] && [ ! -L ${from}/.local/boundary.key ] && grep -qxE '[0-9a-f]{64}' ${from}/.local/boundary.key; then `
    + `(umask 077; cp ${from}/.local/boundary.key ${to}/.local/boundary.key.tmp) && chmod 600 ${to}/.local/boundary.key.tmp `
    + `&& mv ${to}/.local/boundary.key.tmp ${to}/.local/boundary.key; fi; `;
}

// The other push steps, run in /srv/arsip as the arsip user (tests/vps_swap.mjs runs them on a temp folder).
// Build the new copy while the old server keeps serving. The machine lock is pinned on the first push only; it is
// bound to this Tencent instance and the Jakarta region, so a copied disk never matches without --repin.
export const buildScript = ({repin = false, node = NODE} = {}) => carryState()
  + `cd app.new; if [ ! -f .local/machine-lock.json ]; then PIN=--pin; fi; `
  + `PATH=${PATH_VPS} ARSIP_ALLOW_VPS=1 ${node} local/server.mjs --build-only \${PIN:-} ${repin ? '--repin' : ''}`;
const moveDb = to => `for f in app/.local/chat.sqlite*; do if [ -e "$f" ]; then mkdir -p -m 700 ${to}/.local; mv "$f" ${to}/.local/; fi; done; `;
// Swap (server stopped): the chat database and keys move to the new copy; the old copy stays as app.old until the
// new server is up.
export const swapScript = () => moveDb('app.new')
  + `if [ -f app/.env.chat ]; then cp -p app/.env.chat app.new/; fi; rm -rf app.old app.failed; mv app app.old; mv app.new app`;
// Restore after a failed swap or start: the database goes back to app.old, which becomes app again; the new copy is
// kept as app.failed.
export const restoreScript = () => `if [ -d app.old ]; then ${moveDb('app.old')}rm -rf app.failed; `
  + `if [ -d app ]; then mv app app.failed; fi; mv app.old app; fi`;

async function push(opt) {
  const config = read();
  const auth = vpsAuth(config);
  if (!auth?.loggedIn || auth.authMethod !== 'claude.ai') throw new Error('Claude Code di VPS belum login dengan akun Claude. Jalankan: node local/vps.mjs login');
  compareAccounts(auth);
  const files = pushable(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {cwd:ROOT, encoding:'utf8'})
    .split('\0').filter(f => f && existsSync(path.join(ROOT, f))));
  console.log(`Mengirim ${files.length} berkas ke ${config.host}…`);
  await upload(config, files);
  const arsip = script => `sudo -u arsip -H sh -c ${q('set -e; cd /srv/arsip; ' + script)}`;
  must(ssh(config, arsip(buildScript({repin:opt.repin}))), 'Build di VPS (server lama tetap jalan)');
  try {
    must(ssh(config, 'sudo systemctl stop arsip && ' + arsip(swapScript())), 'Mengganti versi');
    sendSecrets(config);
    restart(config);
  } catch (error) {
    console.error('Gagal: ' + error.message + '\nMengembalikan versi sebelumnya…');
    ssh(config, 'sudo systemctl stop arsip; ' + arsip(restoreScript()) + '; sudo systemctl start arsip');
    throw new Error('Versi baru tidak dipakai; versi sebelumnya dijalankan lagi. Salinan gagal: /srv/arsip/app.failed');
  }
  must(ssh(config, arsip('rm -rf app.old app.failed')), 'Membersihkan');
}

// Server settings for the systemd unit (EnvironmentFile). Validated like local/server.mjs options.
export function serverEnv({model = MODEL_DEFAULT, effort = EFFORT_DEFAULT} = {}) {
  checkModel(model, effort);
  return `ARSIP_CLAUDE_MODEL=${model}\nARSIP_CLAUDE_EFFORT=${effort}\n`;
}

function sendSecrets(config) {
  const env = existsSync(path.join(ROOT, '.env.chat')) ? serverSecrets(readFileSync(path.join(ROOT, '.env.chat'), 'utf8')) : '';
  const remote = JSON.stringify({version:1, domain:config.domain, local_port:PORT, secret:config.secret, password:config.password}, null, 2) + '\n';
  const put = (file, text) => must(ssh(config, `sudo -u arsip sh -c ${q(`umask 077 && mkdir -p ${APP}/.local && cat > ${file}.tmp && chmod 600 ${file}.tmp && mv ${file}.tmp ${file}`)}`,
    {input:text}), 'Menulis ' + path.basename(file));
  put(`${APP}/.env.chat`, env);
  put(`${APP}/.local/remote.json`, remote);
  put(`${APP}/.local/server.env`, serverEnv(config));
}

function restart(config) {
  must(ssh(config, 'sudo systemctl restart arsip'), 'Menjalankan server');
  // The server imports new documents into its index before it listens; wait for the listener line.
  // Only this start's log lines count (its systemd invocation ID), not an earlier run's.
  const r = ssh(config, `ID=$(systemctl show -p InvocationID --value arsip); for i in $(seq 1 90); do `
    + `if sudo journalctl _SYSTEMD_INVOCATION_ID="$ID" --no-pager -o cat | grep -q "Akses jarak jauh"; then echo SIAP; exit 0; fi; `
    + `systemctl is-active -q arsip || break; sleep 2; done; sudo journalctl -u arsip -n 25 --no-pager -o cat; exit 1`, {capture:true});
  if (r.status !== 0) throw new Error('Server tidak siap. Log terakhir:\n' + r.stdout);
  console.log(`Server berjalan. Buka https://${config.domain} di perangkat mana pun.`);
}

function status() {
  const config = read();
  console.log(`Domain: https://${config.domain}   VPS: ${config.host}`);
  ssh(config, `echo "arsip: $(systemctl is-active arsip)   caddy: $(systemctl is-active caddy)   zona: $(timedatectl show -p Timezone --value)"; `
    + `free -m | sed -n 2p | awk '{print "RAM terpakai: " $3 " / " $2 " MB"}'; ${asArsip(CLAUDE + ' --version')}; sudo journalctl -u arsip -n 8 --no-pager -o cat`);
  compareAccounts(vpsAuth(config));
}

function logs(opt) {
  ssh(read(), `sudo journalctl -u arsip -n 200 --no-pager ${opt.follow ? '-f' : ''}`, {tty:!!opt.follow});
}

// CacheStore.report() over the VPS chat database, opened read-only: no table is created and nothing is written.
// Piped to node on the VPS as the server user.
export function metricsScript({days = 7, limit = 100, offset = 0} = {}, app = APP) {
  const n = (value, low, high) => Math.max(low, Math.min(high, Math.trunc(Number(value)) || low));
  return `import {DatabaseSync} from 'node:sqlite';
import {CacheStore} from ${JSON.stringify(pathToFileURL(app + '/worker/cache.mjs').href)};
const db = new DatabaseSync(${JSON.stringify(app + '/.local/chat.sqlite')}, {readOnly:true});
const sql = {exec:(query, ...args) => ({toArray:() => db.prepare(query).all(...args)})};
console.log(JSON.stringify(CacheStore.prototype.report.call({sql}, ${n(days, 1, 365)}, ${n(limit, 1, 500)}, ${n(offset, 0, 100000)})));
`;
}

function metrics(opt) {
  const r = must(ssh(read(), asArsip(`${NODE} --input-type=module`), {input:metricsScript(opt), capture:true}), 'Membaca statistik');
  const data = jsonIn(r.stdout || '');
  if (!data) throw new Error('Statistik VPS tidak terbaca.');
  console.log(JSON.stringify({...data, agentic_daily:AGENTIC_DAILY}));
}

function password() {
  const config = read(), value = rotatePassword(config);
  writeConfig(CONFIG, config);
  console.log(`Kata sandi baru (semua perangkat keluar):\n\n    ${value}\n`);
  sendSecrets(config);
  restart(config);
}

function apply() {
  const config = read();
  console.log(`Model ${config.model || MODEL_DEFAULT}, effort ${config.effort || EFFORT_DEFAULT}.`);
  sendSecrets(config);
  restart(config);
}

cli(import.meta.url, ['new-password', 'repin', 'follow'], {setup, bootstrap, login, push, apply, status, logs, password, metrics});
