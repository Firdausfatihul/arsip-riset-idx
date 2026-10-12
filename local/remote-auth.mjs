// Password gate for the remote listener (any device -> Jakarta VPS -> SSH tunnel -> this Mac). Every request
// that arrives through the tunnel must carry a session cookie issued after the password; the check runs here
// on the Mac, so a misconfigured VPS still cannot reach Claude.
import {scryptSync, randomBytes, randomInt, timingSafeEqual, createHmac} from 'node:crypto';

const SCRYPT = {N:32768, r:8, p:1, maxmem:64 * 1024 * 1024};
export const COOKIE = '__Host-arsip_sesi';
const SESSION_DAYS = 30;

export function newPassword() {
  // 20 characters from an unambiguous alphabet, about 100 bits; easy to type once per device.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const chars = Array.from({length:20}, () => alphabet[randomInt(alphabet.length)]).join('');
  return chars.match(/.{1,5}/g).join('-');
}
export function hashPassword(password) {
  const salt = randomBytes(16);
  return {salt:salt.toString('hex'), hash:scryptSync(password.normalize('NFKC'), salt, 32, SCRYPT).toString('hex')};
}
export function checkPassword(password, record) {
  if (typeof password !== 'string' || password.length > 200 || !record?.salt || !record?.hash) return false;
  const actual = scryptSync(password.normalize('NFKC'), Buffer.from(record.salt, 'hex'), 32, SCRYPT);
  const expected = Buffer.from(record.hash, 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

const sign = (secret, value) => createHmac('sha256', Buffer.from(secret, 'hex')).update('arsip-sesi-v1:' + value).digest('base64url');
export function issueSession(secret, now = Date.now()) {
  const expires = now + SESSION_DAYS * 86400000;
  return {value:expires + '.' + sign(secret, String(expires)), maxAge:SESSION_DAYS * 86400};
}
export function validSession(secret, value, now = Date.now()) {
  const m = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(value || '');
  if (!m || Number(m[1]) <= now || Number(m[1]) > now + (SESSION_DAYS + 1) * 86400000) return false;
  const expected = Buffer.from(sign(secret, m[1])), actual = Buffer.from(m[2]);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function cookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// Failed logins: 5 per client per 15 minutes, 30 overall per hour (then all logins wait for the hour to pass).
export class LoginLimiter {
  constructor({perClient = 5, clientWindow = 15 * 60000, global = 30, globalWindow = 3600000} = {}) {
    Object.assign(this, {perClient, clientWindow, global, globalWindow}); this.failures = [];
  }
  prune(now) { this.failures = this.failures.filter(f => f.at > now - this.globalWindow); }
  blocked(client, now = Date.now()) {
    this.prune(now);
    return this.failures.length >= this.global
      || this.failures.filter(f => f.client === client && f.at > now - this.clientWindow).length >= this.perClient;
  }
  fail(client, now = Date.now()) { this.failures.push({client, at:now}); this.prune(now); }
}

const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'})[c]);
export function loginPage(message = '') {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="same-origin"><title>Masuk · Arsip Riset IDX</title><style>
:root{color-scheme:light dark;--bg:#f6f5f2;--fg:#1d1d1b;--line:#c9c6bd;--accent:#1f5f8b}
@media(prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--line:#45443f;--accent:#7db7e0}}
body{margin:0;background:var(--bg);color:var(--fg);font:18px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
form{width:min(360px,calc(100vw - 32px));display:grid;gap:12px}h1{font-size:22px;margin:0 0 4px}
input,button{font:inherit;min-height:48px;border-radius:8px;border:1px solid var(--line);padding:0 12px;background:transparent;color:inherit}
button{background:var(--accent);color:#fff;border:0;font-weight:600}p{margin:0;color:#b3261e}
</style></head><body><form method="post" action="/masuk"><h1>Arsip Riset IDX</h1>
<label for="sandi">Kata sandi</label><input id="sandi" name="sandi" type="password" autocomplete="current-password" required autofocus>
${message ? '<p role="alert">' + escape(message) + '</p>' : ''}<button type="submit">Masuk</button></form></body></html>`;
}
// Referrer-Policy same-origin (not no-referrer): with no-referrer a form POST carries Origin: null, which the
// login CSRF check would refuse. Nothing is sent to other sites either way.
export const LOGIN_HEADERS = {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store', 'Referrer-Policy':'same-origin',
  'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"};
