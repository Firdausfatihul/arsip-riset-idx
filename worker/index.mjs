import {DurableObject} from 'cloudflare:workers';
import {Archive, ChatError, OpenRouter, MODEL, validate, converse} from './core.mjs';

const allowed = (request, env) => !request.headers.get('Origin') ||
  (env.CHAT_ALLOWED_ORIGINS || '').split(',').includes(request.headers.get('Origin'));
function headers(request, type) {
  const value = {'Content-Type':type, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', Vary:'Origin'};
  if (request.headers.get('Origin')) value['Access-Control-Allow-Origin'] = request.headers.get('Origin');
  return value;
}
const json = (request, value, status = 200) => new Response(JSON.stringify(value),
  {status, headers:headers(request, 'application/json; charset=utf-8')});

// The public Worker only routes requests. Document processing uses the Durable Object's
// 30-second active CPU allowance; waiting for OpenRouter does not use that CPU budget.
export default {
  async fetch(request, env) {
    if (!allowed(request, env)) return new Response('Origin tidak diizinkan', {status:403});
    const path = new URL(request.url).pathname;
    if (!['/api/chat', '/api/chat/config'].includes(path)) return new Response('Not found', {status:404});
    if (request.method === 'OPTIONS') return new Response(null, {status:204, headers:{
      ...headers(request, 'text/plain'), 'Access-Control-Allow-Methods':'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type', 'Access-Control-Max-Age':'600'}});
    if (request.method === 'GET' && path === '/api/chat/config')
      return json(request, {ready:!!env.OPENROUTER_API_KEY, model:MODEL});
    if (request.method !== 'POST' || path !== '/api/chat') return new Response('Method not allowed', {status:405});
    if (!env.OPENROUTER_API_KEY) return json(request, {error:'Percakapan belum diaktifkan pengelola.'}, 503);
    // A single named object makes limits and concurrent slots consistent across locations.
    return env.CHAT.get(env.CHAT.idFromName('archive-global-v1')).fetch(request);
  }
};

export class ArchiveChat extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.archive = new Archive(env.ASSETS);
    this.active = 0;
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS requests (stamp INTEGER, client TEXT)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS request_time ON requests(stamp)');
  }
  reserve(client) {
    const now = Math.floor(Date.now() / 1000), day = Math.floor(now / 86400) * 86400;
    // Synchronous SQL in one transaction has no await/interleaving window.
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec('DELETE FROM requests WHERE stamp < ?', Math.min(day, now - 3600));
      const total = sql.exec('SELECT COUNT(*) AS n FROM requests WHERE stamp >= ?', day).one().n;
      const own = sql.exec('SELECT COUNT(*) AS n FROM requests WHERE stamp >= ? AND client = ?', now - 3600, client).one().n;
      if (total >= Number(this.env.CHAT_DAILY_REQUESTS || 100) || own >= Number(this.env.CHAT_HOURLY_PER_IP || 10))
        throw new ChatError('Batas percakapan sementara sudah tercapai. Silakan coba lagi nanti.');
      sql.exec('INSERT INTO requests VALUES (?, ?)', now, client);
    });
  }
  async fetch(request) {
    let body;
    try {
      if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) throw new Error();
      const reader = request.body?.getReader();
      if (!reader) throw new Error();
      const decoder = new TextDecoder(); let text = '', bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) { text += decoder.decode(); break; }
          bytes += part.value.length;
          if (bytes > 150000) throw new Error();
          text += decoder.decode(part.value, {stream:true});
        }
      } finally { await reader.cancel().catch(() => {}); }
      body = validate(JSON.parse(text));
    } catch (error) { return json(request, {error:error instanceof ChatError ? error.message : 'Pertanyaan tidak valid atau terlalu panjang.'}, 400); }
    if (this.active >= 2) return json(request, {error:'Asisten sedang melayani pertanyaan lain. Coba beberapa saat lagi.'}, 429);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.headers.get('CF-Connecting-IP') || 'local'));
    const client = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
    // Recheck after the asynchronous hash, before claiming a slot.
    if (this.active >= 2) return json(request, {error:'Asisten sedang melayani pertanyaan lain. Coba beberapa saat lagi.'}, 429);
    try { this.reserve(client); }
    catch (error) { return json(request, {error:error instanceof ChatError ? error.message : 'Batas pemakaian belum dapat diperiksa.'}, 429); }
    this.active++;
    const controller = new AbortController(), stream = new TransformStream(), writer = stream.writable.getWriter();
    const encoder = new TextEncoder();
    const timer = setTimeout(() => controller.abort(), 14 * 60 * 1000);
    const emit = async value => {
      controller.signal.throwIfAborted();
      try { await writer.write(encoder.encode(JSON.stringify(value) + '\n')); }
      catch (error) { controller.abort(); throw error; }
    };
    writer.closed.catch(() => controller.abort());
    const run = async () => {
      try {
        await converse(this.archive, new OpenRouter(this.env.OPENROUTER_API_KEY, controller.signal),
          body.question, body.history, emit, controller.signal);
      } catch (error) {
        if (!(error instanceof ChatError)) console.error('Chat transport failure:', error.name,
          error.stack?.split('\n')[1]?.trim() || 'no stack');
        const message = error instanceof ChatError ? error.message : 'Koneksi atau proses analisis terhenti. Silakan coba lagi.';
        // On timeout the response may still be writable; signal the incomplete result.
        try { await writer.write(encoder.encode(JSON.stringify({type:'error', text:message}) + '\n')); } catch {}
      } finally {
        clearTimeout(timer); controller.abort(); this.active--;
        await writer.close().catch(() => {});
      }
    };
    this.ctx.waitUntil(run());
    return new Response(stream.readable, {headers:headers(request, 'application/x-ndjson; charset=utf-8')});
  }
}
