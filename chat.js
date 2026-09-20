/* Archive conversation: credentials and document retrieval stay on the server. */
(function(){
  'use strict';
  var data = JSON.parse(document.getElementById('arsip-data').textContent);
  var endpoint = data.chatApi || '/api/chat';
  var form = document.getElementById('chat-form'), input = document.getElementById('chat-question');
  var log = document.getElementById('chat-history'), status = document.getElementById('chat-status');
  var send = document.getElementById('chat-send'), stop = document.getElementById('chat-stop');
  var reset = document.getElementById('chat-new'), history = [], controller = null;
  var knownPaths = new Set(data.docs.map(function(d){ return d.path; }));

  function docHref(path){ return '#doc=' + encodeURIComponent(path).replace(/%2F/g, '/'); }

  function message(role, text){
    var block = document.createElement('section'), label = document.createElement('h3');
    block.className = 'chat-message ' + role;
    label.textContent = role === 'user' ? 'Kamu' : 'Jawaban dari arsip';
    block.appendChild(label);
    var content = document.createElement(role === 'user' ? 'p' : 'div');
    content.textContent = text;
    if (role !== 'user') content.className = 'chat-answer';
    block.appendChild(content);
    log.appendChild(block);
    return {block: block, content: content};
  }

  function sourceList(block, sources){
    var details = document.createElement('details'), summary = document.createElement('summary');
    details.className = 'chat-sources';
    summary.textContent = sources.length + ' dokumen ditemukan';
    details.appendChild(summary);
    var list = document.createElement('ol');
    sources.forEach(function(s){
      var item = document.createElement('li'), link = document.createElement('a');
      link.href = docHref(s.path);
      link.textContent = '[' + s.source_id + '] ' + s.title + ' · ' + s.label;
      item.appendChild(link); list.appendChild(item);
    });
    details.appendChild(list); block.appendChild(details);
    return summary;
  }

  function renderAnswer(target, text, sources){
    if (!window.marked || !window.DOMPurify){ target.textContent = text; return; }
    var byId = {};
    sources.forEach(function(s){ byId[s.source_id] = s; });
    var markdown = text.replace(/\[(D\d+)\]/g, function(label, id){
      return byId[id] ? '[' + id + '](' + docHref(byId[id].path) + ')' : label;
    });
    target.innerHTML = window.DOMPurify.sanitize(window.marked.parse(markdown, {gfm: true}),
      {FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'source', 'svg', 'math']});
    // Only verified archive citations are clickable; model-generated URLs are not source evidence.
    var allowed = new Set(sources.map(function(s){ return docHref(s.path); }));
    target.querySelectorAll('a').forEach(function(a){
      if (!allowed.has(a.getAttribute('href'))) a.replaceWith(a.textContent);
    });
    target.classList.add('rendered');
  }

  function busy(value){
    send.disabled = value; input.disabled = value; stop.hidden = !value; reset.disabled = value;
    log.setAttribute('aria-busy', String(value));
  }

  form.addEventListener('submit', async function(event){
    event.preventDefault();
    var question = input.value.trim();
    if (!question || controller) return;
    if (history.length >= 40){ status.textContent = 'Percakapan sudah panjang. Pilih Percakapan baru untuk melanjutkan.'; return; }
    controller = new AbortController();
    busy(true); reset.hidden = false;
    message('user', question);
    var reply = message('assistant', ''), text = '', sources = [], summary = null, done = false;
    status.textContent = 'Menghubungkan ke asisten arsip…';
    var timeout = setTimeout(function(){ if (controller) controller.abort('timeout'); }, 15 * 60 * 1000);
    try {
      var response = await fetch(endpoint, {method: 'POST', signal: controller.signal,
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({question: question, history: history})});
      if (!response.ok){
        var problem = await response.json().catch(function(){ return {}; });
        throw new Error(problem.error || 'Percakapan belum tersedia. Silakan coba lagi nanti.');
      }
      if (!response.body || !/application\/x-ndjson/.test(response.headers.get('Content-Type') || '')){
        throw new Error('Percakapan belum diaktifkan oleh pengelola. Pencarian dokumen tetap bisa dipakai.');
      }
      var stream = response.body.getReader(), decoder = new TextDecoder(), pending = '';
      function receive(line){
        if (!line.trim()) return;
        var event = JSON.parse(line);
        if (event.type === 'status') status.textContent = event.text;
        if (event.type === 'sources'){
          sources = event.sources.filter(function(s){ return knownPaths.has(s.path) && /^D\d+$/.test(s.source_id); });
          if (sources.length !== event.sources.length) throw new Error('Daftar arsip sudah diperbarui. Muat ulang halaman lalu coba lagi.');
          summary = sourceList(reply.block, sources);
        }
        if (event.type === 'delta'){
          text += event.text; reply.content.textContent = text;
        }
        if (event.type === 'error') throw new Error(event.text);
        if (event.type === 'done'){
          done = true;
          if (summary) summary.textContent = sources.length + ' dokumen dibaca · lihat sumber';
        }
      }
      while (true){
        var part = await stream.read();
        pending += decoder.decode(part.value || new Uint8Array(), {stream: !part.done});
        var lines = pending.split('\n'); pending = lines.pop();
        lines.forEach(receive);
        if (part.done){ receive(pending); break; }
      }
      if (!done || !text.trim()) throw new Error('Jawaban terputus sebelum selesai. Silakan coba lagi.');
      renderAnswer(reply.content, text, sources);
      history.push({role: 'user', content: question}, {role: 'assistant', content: text});
      input.value = ''; input.placeholder = 'Tanyakan lanjutannya, misalnya: bagaimana risiko pendanaannya?';
      status.textContent = 'Jawaban selesai dari ' + sources.length + ' dokumen. Kamu bisa bertanya lagi.';
    } catch (error){
      var aborted = controller.signal.aborted;
      var description = aborted ? (controller.signal.reason === 'timeout' ? 'Proses terlalu lama. Coba pertanyaan yang lebih spesifik.' : 'Proses dihentikan.') :
        (error instanceof TypeError ? 'Koneksi ke asisten terputus. Periksa koneksi lalu coba lagi.' : error.message);
      controller.abort();
      var warning = document.createElement('p'); warning.className = 'chat-error';
      warning.textContent = description + (text ? ' Teks di atas belum menjadi jawaban lengkap.' : '');
      reply.block.appendChild(warning);
      var retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Coba lagi';
      retry.addEventListener('click', function(){
        if (controller) return;
        input.value = question; form.requestSubmit();
      });
      reply.block.appendChild(retry); status.textContent = description;
    } finally {
      clearTimeout(timeout); controller = null; busy(false);
    }
  });

  stop.addEventListener('click', function(){ if (controller) controller.abort(); });
  reset.addEventListener('click', function(){
    if (controller) return;
    history = []; log.replaceChildren(); status.textContent = ''; input.value = '';
    input.placeholder = 'Contoh: Analisis SOCI dari semua dokumen yang tersedia';
    reset.hidden = true; input.focus();
  });
})();
