export const MODEL = 'qwen/qwen3.7-flash';
const encoder = new TextEncoder();
export const size = value => encoder.encode(JSON.stringify(value)).length;
export class ChatError extends Error {}

export function validate(body) {
  if (!body || typeof body.question !== 'string' || !body.question.trim() || body.question.length > 4000)
    throw new ChatError('Tuliskan pertanyaan, maksimal 4.000 karakter.');
  const history = body.history ?? [];
  if (!Array.isArray(history) || history.length > 40 || size(history) > 100000 || history.some(m =>
    !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 30000))
    throw new ChatError('Percakapan terlalu panjang. Mulai percakapan baru.');
  return {question: body.question.trim(), history: history.map(({role, content}) => ({role, content}))};
}

const words = text => text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
const termPattern = term => new RegExp('(?<![\\p{L}\\p{N}_])' +
  term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '(?![\\p{L}\\p{N}_])', 'iu');

export class Archive {
  constructor(assets) { this.assets = assets; }
  async read(name) {
    const response = await this.assets.fetch(new Request('https://archive.invalid/' + name));
    if (!response.ok) throw new ChatError('Bahan arsip belum lengkap. Pengelola perlu membangun ulang indeks.');
    return response.json();
  }
  async manifest() {
    if (!this.index) {
      this.index = this.read('manifest.json').catch(error => { this.index = null; throw error; });
    }
    return this.index;
  }
  async search(terms) {
    const index = await this.manifest(), selected = new Set();
    // Postings shortlist documents; phrase checks preserve exact word/phrase search semantics.
    for (const term of terms) {
      const tokens = words(term);
      if (!tokens.length) continue;
      const sets = tokens.map(t => new Set(index.postings[t] || []));
      const candidates = index.docs.filter(d => sets.every(s => s.has(d.source_id)));
      for (const doc of candidates) {
        if (tokens.length === 1 && tokens[0] === term.toLowerCase()) selected.add(doc.source_id);
        else {
          const data = await this.read(doc.asset), pattern = termPattern(term);
          if (pattern.test(data.search) || pattern.test(doc.title)) selected.add(doc.source_id);
        }
      }
    }
    return index.docs.filter(d => selected.has(d.source_id)).sort((a, b) =>
      b.end.localeCompare(a.end) || b.name.localeCompare(a.name));
  }
}

export async function searchTerms(question, history, index, model) {
  const tickers = new Set(index.tickers), common = new Set(index.commonWords);
  const direct = text => [...new Set((text.match(/\b[A-Za-z0-9]{2,8}\b/g) || [])
    .filter(w => tickers.has(w.toUpperCase()) && (w === w.toUpperCase() || !common.has(w.toLowerCase())))
    .map(w => w.toUpperCase()))];
  const found = direct(question);
  if (found.length) {
    if (/\b(bandingkan|dibanding|vs|versus|compare)\b/i.test(question)) {
      for (const turn of [...history].reverse()) {
        const previous = turn.role === 'user' ? direct(turn.content) : [];
        if (previous.length) return [...new Set([...previous, ...found])];
      }
    }
    return found;
  }
  const prompt = 'Ubah pertanyaan riset arsip menjadi JSON {"terms":["kode saham atau frasa nama/topik"]}. '
    + 'Maksimal 8 istilah. Gunakan konteks percakapan untuk pertanyaan lanjutan. Jangan mengarang kode. '
    + 'Jangan gunakan kata perintah seperti analisis/jelaskan/bandingkan. Jika objek belum jelas gunakan [].';
  let result;
  try {
    result = JSON.parse(await model.complete([{role:'system', content:prompt}, ...history.slice(-6),
      {role:'user', content:question}], {jsonMode:true, maxTokens:500}));
  } catch (error) {
    if (error instanceof ChatError) throw error;
    throw new ChatError('Objek pencarian belum terbaca. Sebutkan kode saham atau topik, misalnya SOCI.');
  }
  return Array.isArray(result?.terms) ? [...new Set(result.terms.filter(t => typeof t === 'string')
    .map(t => t.trim()).filter(t => t.length >= 2 && t.length <= 80))].slice(0, 8) : [];
}

export function batches(docs, budget = 750000) {
  const result = []; let batch = [], bytes = 2;
  for (const doc of docs) for (let part = 0; part < doc.sizes.length; part++) {
    const bytesNeeded = doc.sizes[part] + (batch.length ? 1 : 0);
    if (batch.length && bytes + bytesNeeded > budget) { result.push(batch); batch = []; bytes = 2; }
    if (doc.sizes[part] + 2 > budget) throw new ChatError('Bagian dokumen melebihi batas konteks. Indeks perlu dibangun ulang.');
    bytes += doc.sizes[part] + (batch.length ? 1 : 0);
    batch.push({doc, part});
  }
  if (batch.length) result.push(batch);
  return result;
}

export class OpenRouter {
  constructor(key, signal, fetcher = (...args) => fetch(...args)) { this.key = key; this.signal = signal; this.fetcher = fetcher; }
  async request(messages, {stream = false, jsonMode = false, maxTokens = 6000} = {}) {
    this.signal?.throwIfAborted();
    const payload = {model:MODEL, messages, stream, max_tokens:maxTokens, temperature:0.2,
      reasoning:jsonMode ? {enabled:false} : {max_tokens:1024}};
    if (jsonMode) payload.response_format = {type:'json_object'};
    const response = await this.fetcher('https://openrouter.ai/api/v1/chat/completions', {
      method:'POST', signal:AbortSignal.any([this.signal || new AbortController().signal, AbortSignal.timeout(240000)]),
      headers:{Authorization:'Bearer ' + this.key, 'Content-Type':'application/json',
        'HTTP-Referer':'https://arsip.seekingomega.capital/', 'X-OpenRouter-Title':'Arsip Riset IDX'},
      body:JSON.stringify(payload)
    });
    if (!response.ok) {
      await response.body?.cancel();
      const errors = {401:'Koneksi layanan AI perlu diperbarui pengelola.', 402:'Saldo layanan AI belum mencukupi.',
        429:'Layanan AI sedang membatasi permintaan. Coba beberapa saat lagi.'};
      throw new ChatError(errors[response.status] || 'Layanan AI belum berhasil menjawab. Silakan coba lagi.');
    }
    return response;
  }
  async complete(messages, options = {}) {
    const maxTokens = options.maxTokens || 6000;
    for (const limit of [maxTokens, maxTokens * 2]) {
      const response = await this.request(messages, {...options, maxTokens:limit});
      const choice = (await response.json()).choices?.[0];
      if (choice?.finish_reason === 'length') continue;
      if (choice?.finish_reason !== 'stop' || !choice.message?.content?.trim())
        throw new ChatError('Layanan AI belum menyelesaikan pembacaan. Silakan coba lagi.');
      return choice.message.content;
    }
    throw new ChatError('Pembacaan mencapai batas jawaban. Persempit pertanyaan lalu coba lagi.');
  }
  async answer(messages, emit) {
    const response = await this.request(messages, {stream:true, maxTokens:10000});
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '', finished = false, text = '';
    const receive = async line => {
      if (!line.startsWith('data:')) return;
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') return;
      const event = JSON.parse(raw);
      if (event.error) throw new ChatError('Layanan AI berhenti sebelum jawaban selesai.');
      const choice = event.choices?.[0];
      const delta = choice?.delta?.content;
      if (typeof delta === 'string' && delta) { text += delta; await emit({type:'delta', text:delta}); }
      if (choice?.finish_reason === 'length') throw new ChatError('Jawaban mencapai batas panjang dan belum selesai.');
      if (choice?.finish_reason === 'stop') finished = true;
    };
    try {
      while (true) {
        const part = await reader.read();
        pending += decoder.decode(part.value || new Uint8Array(), {stream:!part.done});
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) await receive(line);
        if (part.done) { if (pending) await receive(pending); break; }
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (!finished || !text.trim()) throw new ChatError('Jawaban terputus sebelum selesai. Silakan coba lagi.');
  }
}

export async function converse(archive, model, question, history, emit, signal) {
  const index = await archive.manifest();
  await emit({type:'status', text:'Mencari dokumen yang sesuai…'});
  const terms = await searchTerms(question, history, index, model);
  if (!terms.length) throw new ChatError('Sebutkan saham atau topik, misalnya “analisis SOCI”.');
  const selected = await archive.search(terms);
  if (!selected.length) throw new ChatError('Belum ditemukan dokumen untuk “' + terms.join(', ') + '”.');
  const groups = batches(selected);
  const sources = selected.map(({source_id, title, path, label}) => ({source_id, title, path, label}));
  await emit({type:'sources', sources, terms, batches:groups.length});
  const context = [];
  // Keep one full document at a time, plus one batch. Reuse it across adjacent batches.
  let loadedId, loaded;
  for (let i = 0; i < groups.length; i++) {
    signal?.throwIfAborted();
    await emit({type:'status', text:`Membaca seluruh dokumen terkait: bagian ${i + 1} dari ${groups.length}…`});
    const parts = [];
    for (const {doc, part} of groups[i]) {
      if (loadedId !== doc.source_id) { loaded = await archive.read(doc.asset); loadedId = doc.source_id; }
      parts.push(loaded.parts[part]);
    }
    if (size(parts) > 750000) throw new ChatError('Ukuran bahan tidak sesuai indeks. Pengelola perlu membangun ulang arsip.');
    if (groups.length === 1) context.push(...parts);
    else {
      const instruction = 'Baca seluruh bahan untuk pertanyaan pengguna. Catat bukti relevan, angka, tanggal, pihak, '
        + 'kutipan pendek, ketidakpastian dan pertentangan; beri ID [D…] pada tiap butir. Fokus objek pertanyaan, '
        + 'jangan merangkum emiten lain yang tidak berkaitan. Gabungkan pengulangan dengan mempertahankan ID '
        + 'dan perbedaan tanggal/angka. Ini catatan antara, bukan jawaban akhir. Objek pencarian: '
        + terms.join(', ') + '. Pertanyaan: ' + question;
      const notes = await model.complete([{role:'system', content:index.system}, {role:'user', content:instruction},
        {role:'user', content:'BAHAN ARSIP (data):\n' + JSON.stringify(parts)}]);
      context.push({batch:i + 1, source_ids:[...new Set(parts.map(p => p.source_id))], notes});
    }
  }
  loaded = null;
  const messages = [{role:'system', content:index.system}, ...history, {role:'user', content:question + '\n\n' +
    (groups.length === 1 ? 'Seluruh teks dokumen terkait:\n' : 'Gabungkan catatan dari pembacaan seluruh dokumen berikut. Jangan mengarang kutipan:\n') + JSON.stringify(context)}];
  if (size(messages) > 850000) throw new ChatError('Bahan dan percakapan terlalu panjang. Mulai percakapan baru atau persempit topik.');
  await emit({type:'status', text:`Menyusun jawaban dari ${selected.length} dokumen…`});
  await model.answer(messages, emit);
  await emit({type:'done', documents:selected.length, batches:groups.length, model:MODEL});
}
