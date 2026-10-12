#!/usr/bin/env node
// Remote access from any device (phone, laptop, tablet) through a Jakarta VPS, with Claude still running only on this Mac:
//
//   device --HTTPS--> VPS (Caddy, Jakarta) --127.0.0.1:18017--> SSH reverse tunnel --> Mac 127.0.0.1:8018 (password gate)
//
// The VPS holds no Claude login and no archive data; it terminates HTTPS and forwards into the tunnel that
// this Mac opens. The tunnel key may only open that one forward (no shell). Nothing listens publicly on the Mac.
//
//   node local/remote.mjs setup --vps <ip> --domain <name>   key, password, settings, .local/vps-setup.sh
//   node local/remote.mjs install                             start server + tunnel now and at login (launchd)
//   node local/remote.mjs status | uninstall | password | tunnel
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {newPassword, hashPassword} from './remote-auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, '.local');
const CONFIG = path.join(STATE, 'remote.json');
const KEY = path.join(homedir(), '.ssh', 'arsip_tunnel');
const KNOWN = path.join(STATE, 'known_hosts');
const AGENTS = path.join(homedir(), 'Library', 'LaunchAgents');
const LOGS = path.join(homedir(), 'Library', 'Logs');
const LABELS = {server:'capital.seekingomega.arsip.server', tunnel:'capital.seekingomega.arsip.tunnel'};
const VPS_PORT = 18017, LOCAL_PORT = 8018;

function args(argv) {
  const out = {_:[]};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { out._.push(argv[i]); continue; }
    const key = argv[i].slice(2);
    if (['new-password'].includes(key)) { out[key] = true; continue; }
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error('Opsi --' + key + ' perlu nilai.');
    out[key] = argv[++i];
  }
  return out;
}
const read = () => { if (!existsSync(CONFIG)) throw new Error('Belum di-setup. Jalankan: node local/remote.mjs setup --vps <ip> --domain <nama>'); return JSON.parse(readFileSync(CONFIG, 'utf8')); };
const write = config => { mkdirSync(STATE, {recursive:true, mode:0o700}); writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n', {mode:0o600}); chmodSync(CONFIG, 0o600); };
const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

export function validate({vps, domain, sshPort, sshUser}) {
  if (!/^[A-Za-z0-9.:-]+$/.test(vps || '')) throw new Error('--vps harus alamat IP atau nama host VPS.');
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain || ''))
    throw new Error('--domain harus nama domain huruf kecil, mis. arsip.seekingomega.capital (A record ke IP VPS).');
  if (!Number.isSafeInteger(sshPort) || sshPort < 1 || sshPort > 65535) throw new Error('--ssh-port tidak valid.');
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(sshUser)) throw new Error('--ssh-user tidak valid.');
}

// Root script for a fresh Debian 12 / Ubuntu 24.04 VPS. Idempotent; only touches the tunnel user, one sshd
// drop-in and the Caddyfile (backed up first).
export function vpsScript({domain, publicKey}) {
  return `#!/usr/bin/env bash
# Arsip Riset IDX: relay VPS (Jakarta). Jalankan sebagai root: bash vps-setup.sh
set -euo pipefail
DOMAIN=${shellQuote(domain)}
PUBKEY=${shellQuote(publicKey)}
PORT=${VPS_PORT}
[ "$(id -u)" = 0 ] || { echo "Jalankan sebagai root."; exit 1; }
echo "Zona waktu VPS: $(cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || echo '?')"
apt-get update -qq
apt-cache show caddy >/dev/null 2>&1 || { echo "Paket caddy tidak ada. Pakai Debian 12 atau Ubuntu 24.04."; exit 1; }
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy openssh-server

# Tunnel user: no password, no shell, may only listen on 127.0.0.1:$PORT.
id arsip-tunnel >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin arsip-tunnel
install -d -m 700 -o arsip-tunnel -g arsip-tunnel /home/arsip-tunnel/.ssh
printf 'restrict,port-forwarding,permitlisten="127.0.0.1:%s",command="/bin/false" %s\\n' "$PORT" "$PUBKEY" > /home/arsip-tunnel/.ssh/authorized_keys
chown arsip-tunnel:arsip-tunnel /home/arsip-tunnel/.ssh/authorized_keys
chmod 600 /home/arsip-tunnel/.ssh/authorized_keys
cat > /etc/ssh/sshd_config.d/arsip-tunnel.conf <<'EOF'
Match User arsip-tunnel
    AllowTcpForwarding remote
    GatewayPorts no
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    PasswordAuthentication no
    KbdInteractiveAuthentication no
EOF
sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd

# HTTPS (Let's Encrypt) and forwarding into the tunnel. The chat streams NDJSON: flush immediately.
[ -f /etc/caddy/Caddyfile ] && cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%Y%m%d%H%M%S)"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	header Strict-Transport-Security "max-age=31536000"
	header -Server
	reverse_proxy 127.0.0.1:$PORT {
		flush_interval -1
	}
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable --now caddy
systemctl reload caddy
echo
echo "Selesai. Pastikan port 80 dan 443 terbuka di firewall penyedia VPS, dan A record $DOMAIN mengarah ke VPS ini."
echo "Sidik jari host SSH VPS (cocokkan dengan yang tercatat di Mac saat tunnel pertama tersambung):"
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
`;
}

export function tunnelArgs(config) {
  return ['-N', '-T', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + KNOWN,
    '-o', 'ConnectTimeout=15', '-i', KEY, '-p', String(config.ssh_port),
    '-R', `127.0.0.1:${VPS_PORT}:127.0.0.1:${config.local_port}`, 'arsip-tunnel@' + config.vps_host];
}

function plist(label, program, log) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${esc(label)}</string>
<key>ProgramArguments</key><array>${program.map(p => `<string>${esc(p)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${esc(ROOT)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(process.env.PATH)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer>
<key>StandardOutPath</key><string>${esc(log)}</string><key>StandardErrorPath</key><string>${esc(log)}</string>
</dict></plist>
`;
}
const uid = () => String(process.getuid());
const unload = label => spawnSync('launchctl', ['bootout', `gui/${uid()}/${label}`], {stdio:'ignore'});

function setup(opt) {
  const old = existsSync(CONFIG) ? read() : null;
  const config = {version:1, vps_host:opt.vps || old?.vps_host, domain:(opt.domain || old?.domain || '').toLowerCase(),
    ssh_port:Number(opt['ssh-port'] || old?.ssh_port || 22), ssh_admin:opt['ssh-user'] || old?.ssh_admin || 'root', local_port:LOCAL_PORT,
    secret:old?.secret, password:old?.password};
  validate({vps:config.vps_host, domain:config.domain, sshPort:config.ssh_port, sshUser:config.ssh_admin});
  if (!existsSync(KEY)) {
    mkdirSync(path.dirname(KEY), {recursive:true, mode:0o700});
    execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'arsip-tunnel', '-f', KEY], {stdio:'ignore'});
  }
  let password = null;
  if (!config.password || opt['new-password']) { password = newPassword(); config.password = hashPassword(password); config.secret = randomBytes(32).toString('hex'); }
  write(config);
  const script = path.join(STATE, 'vps-setup.sh');
  writeFileSync(script, vpsScript({domain:config.domain, publicKey:readFileSync(KEY + '.pub', 'utf8').trim()}), {mode:0o600});
  const target = `${config.ssh_admin}@${config.vps_host}`, port = config.ssh_port === 22 ? '' : ` -P ${config.ssh_port}`, sshPort = config.ssh_port === 22 ? '' : ` -p ${config.ssh_port}`;
  console.log(`Pengaturan tersimpan: ${CONFIG}`);
  if (password) console.log(`\nKATA SANDI untuk semua perangkat (simpan di pengelola sandi; tidak ditampilkan lagi):\n\n    ${password}\n`);
  console.log(`Langkah berikutnya:
  1. DNS: buat A record  ${config.domain}  ->  ${config.vps_host}
  2. VPS:  scp${port} ${script} ${target}:/root/  &&  ssh${sshPort} ${target} bash /root/vps-setup.sh
  3. Mac:  node local/remote.mjs install
  4. Perangkat mana pun (ponsel, laptop, tablet): buka https://${config.domain} lalu masukkan kata sandi sekali (sesi 30 hari per perangkat).`);
}

function install() {
  const config = read();
  validate({vps:config.vps_host, domain:config.domain, sshPort:config.ssh_port, sshUser:config.ssh_admin});
  if (process.platform !== 'darwin') throw new Error('install hanya untuk macOS (launchd).');
  mkdirSync(AGENTS, {recursive:true}); mkdirSync(LOGS, {recursive:true});
  // caffeinate -s keeps the Mac awake while on power so other devices can reach it; on battery it may still sleep.
  const programs = {
    server:['/usr/bin/caffeinate', '-s', process.execPath, path.join(ROOT, 'local', 'server.mjs')],
    tunnel:['/usr/bin/ssh', ...tunnelArgs(config)],
  };
  for (const [name, label] of Object.entries(LABELS)) {
    const file = path.join(AGENTS, label + '.plist');
    unload(label);
    writeFileSync(file, plist(label, programs[name], path.join(LOGS, `arsip-${name}.log`)), {mode:0o644});
    const r = spawnSync('launchctl', ['bootstrap', `gui/${uid()}`, file], {encoding:'utf8'});
    if (r.status !== 0) throw new Error(`launchctl bootstrap ${label} gagal: ${r.stderr.trim()}`);
  }
  console.log(`Server dan tunnel berjalan sekarang dan otomatis saat login.
Log: ${path.join(LOGS, 'arsip-server.log')} dan ${path.join(LOGS, 'arsip-tunnel.log')}
Akses dari perangkat lain: https://${config.domain}`);
}

function uninstall() {
  for (const label of Object.values(LABELS)) { unload(label); rmSync(path.join(AGENTS, label + '.plist'), {force:true}); }
  console.log('Server dan tunnel dihentikan dan tidak lagi otomatis. Pengaturan .local/remote.json tetap ada.');
}

function status() {
  const config = existsSync(CONFIG) ? read() : null;
  console.log(config ? `Domain: https://${config.domain}  VPS: ${config.vps_host}:${config.ssh_port}` : 'Belum di-setup.');
  for (const [name, label] of Object.entries(LABELS)) {
    const r = spawnSync('launchctl', ['print', `gui/${uid()}/${label}`], {encoding:'utf8'});
    const state = r.status === 0 ? (r.stdout.match(/state = (\w+)/)?.[1] || '?') : 'tidak terpasang';
    console.log(`${name.padEnd(7)} ${state}`);
  }
}

function password() {
  const config = read();
  const value = newPassword();
  config.password = hashPassword(value); config.secret = randomBytes(32).toString('hex');
  write(config);
  console.log(`Kata sandi baru (semua sesi lama keluar setelah server dimulai ulang):\n\n    ${value}\n`);
  if (spawnSync('launchctl', ['print', `gui/${uid()}/${LABELS.server}`], {stdio:'ignore'}).status === 0) {
    spawnSync('launchctl', ['kickstart', '-k', `gui/${uid()}/${LABELS.server}`], {stdio:'inherit'});
    console.log('Server dimulai ulang.');
  }
}

function tunnel() {
  const r = spawnSync('/usr/bin/ssh', tunnelArgs(read()), {stdio:'inherit'});
  process.exit(r.status ?? 1);
}

const main = () => {
  const opt = args(process.argv.slice(2));
  const command = opt._[0];
  const commands = {setup:() => setup(opt), install, uninstall, status, password, tunnel};
  if (!commands[command]) throw new Error('Perintah: setup | install | uninstall | status | password | tunnel');
  commands[command]();
};
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  try { main(); } catch (error) { console.error('Gagal: ' + error.message); process.exit(1); }
