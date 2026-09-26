/* Archive conversation: credentials and document retrieval stay on the server. */
(function(){
  'use strict';
  var data = JSON.parse(document.getElementById('arsip-data').textContent);
  var endpoint = data.chatApi || '/api/chat';
  var form = document.getElementById('chat-form'), input = document.getElementById('chat-question');
  var log = document.getElementById('chat-history'), status = document.getElementById('chat-status');
  var send = document.getElementById('chat-send'), stop = document.getElementById('chat-stop');
  var reset = document.getElementById('chat-new'), context = null, turns = 0, controller = null;
  var progress = document.getElementById('chat-progress'), meter = document.getElementById('chat-meter');
  var activity = document.getElementById('chat-activity'), elapsed = document.getElementById('chat-elapsed');
  var count = document.getElementById('chat-count');
  var modeBox = document.getElementById('chat-mode'), agenticInput = document.getElementById('chat-agentic');
  var agenticLeft = document.getElementById('chat-agentic-left'), agenticLimit = 10;
  // datacat pages are the only external links an answer may carry; the server assigns them.
  var DATACAT = /^https:\/\/quant\.renr\.ai\/[A-Za-z0-9\/_.%-]+$/;
  function showLeft(left){
    if (typeof left !== 'number' || !isFinite(left)) return;
    agenticLeft.textContent = 'Sisa ' + left + ' dari ' + agenticLimit + ' pertanyaan hari ini untuk seluruh situs.';
    agenticInput.disabled = left <= 0;
    if (left <= 0) agenticInput.checked = false;
  }
  function loadConfig(){
    fetch(endpoint + '/config').then(function(r){ return r.ok ? r.json() : null; }).then(function(config){
      if (!config || !config.agentic || !config.agentic.enabled) return;
      agenticLimit = config.agentic.limit || 10; modeBox.hidden = false; showLeft(config.agentic.left);
    }).catch(function(){});
  }
  loadConfig();
  function countInput(){ count.textContent = input.value.length + ' / 600 karakter'; }
  input.addEventListener('input', countInput);
  var knownPaths = new Set(data.docs.map(function(d){ return d.path; }));

  function docHref(path){ return '#doc=' + encodeURIComponent(path).replace(/%2F/g, '/'); }
  function sourceHref(s){ return s.url ? s.url : docHref(s.path); }
  function external(a){ a.target = '_blank'; a.rel = 'noopener noreferrer'; }

  function message(role, text, agentic){
    var block = document.createElement('section'), label = document.createElement('h3');
    block.className = 'chat-message ' + role;
    label.textContent = role === 'user' ? 'Kamu' : agentic ? 'Jawaban mode agen' : 'Jawaban dari arsip';
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
    summary.textContent = sources.length + ' sumber ditemukan';
    details.appendChild(summary);
    var list = document.createElement('ol');
    sources.forEach(function(s){
      var item = document.createElement('li'), link = document.createElement('a');
      link.href = sourceHref(s);
      if (s.url) external(link);
      link.textContent = '[' + s.source_id + '] ' + s.title + ' · ' + s.label + (s.url ? ' · datacat' : '');
      item.appendChild(link); list.appendChild(item);
    });
    details.appendChild(list); block.appendChild(details);
    return summary;
  }

  function renderAnswer(target, text, sources){
    if (!window.marked || !window.DOMPurify){ target.textContent = text; return; }
    var byId = {};
    sources.forEach(function(s){ byId[s.source_id] = s; });
    // "[K1, K2]" and "[K1-K3]" link each id, like the server's citation reader (worker/agent.mjs).
    var markdown = text.replace(/\[((?:[DK]\d+)(?:\s*(?:,|;|-|–)\s*[DK]?\d+)*)\]/g, function(label, group){
      var ids = [];
      group.split(/\s*[,;]\s*/).forEach(function(part){
        var range = part.match(/^([DK])(\d+)\s*[-–]\s*[DK]?(\d+)$/);
        if (range) for (var n = +range[2]; n <= Math.min(+range[3], +range[2] + 30); n++) ids.push(range[1] + n);
        else ids.push(part);
      });
      if (!ids.some(function(id){ return byId[id]; })) return label;
      return ids.map(function(id){ return byId[id] ? '[' + id + '](' + sourceHref(byId[id]) + ')' : id; }).join(' ');
    });
    var fragment = window.DOMPurify.sanitize(window.marked.parse(markdown, {gfm: true}), {
      ALLOWED_TAGS: ['p','br','strong','em','del','blockquote','ul','ol','li','h2','h3','h4','hr','pre','code','table','thead','tbody','tr','th','td','a'],
      ALLOWED_ATTR: ['href'], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, RETURN_DOM_FRAGMENT: true
    });
    // Check links while detached, before any model-generated markup enters the page.
    var allowed = new Set(sources.map(sourceHref));
    fragment.querySelectorAll('a').forEach(function(a){
      if (!allowed.has(a.getAttribute('href'))) a.replaceWith(a.textContent);
      else if (DATACAT.test(a.getAttribute('href'))) external(a);
    });
    fragment.querySelectorAll('table').forEach(function(table){
      var rows = Array.from(table.rows);
      var columns = Math.max.apply(null, rows.map(function(row){ return row.cells.length; }));
      for (var column = 0; column < columns; column++) {
        var cells = rows.map(function(row){ return row.cells[column]; }).filter(Boolean);
        if (cells.every(function(cell){ return cell.textContent.trim().length <= 12; })) {
          cells.forEach(function(cell){ cell.classList.add('chat-cell-compact'); });
        }
      }
      var scroll = document.createElement('div');
      scroll.className = 'chat-table-scroll'; scroll.tabIndex = 0;
      scroll.setAttribute('role', 'region');
      scroll.setAttribute('aria-label', 'Tabel jawaban; geser ke samping untuk melihat kolom lainnya');
      table.replaceWith(scroll); scroll.appendChild(table);
    });
    target.replaceChildren(fragment);
    target.classList.add('rendered');
  }

  function busy(value){
    send.disabled = value; input.disabled = value; stop.hidden = !value; reset.disabled = value; agenticInput.disabled = value;
    log.setAttribute('aria-busy', String(value));
    progress.hidden = !value;
    if (value){ meter.removeAttribute('value'); activity.textContent = 'Asisten mulai bekerja…'; elapsed.textContent = '0 detik'; }
  }

  form.addEventListener('submit', async function(event){
    event.preventDefault();
    var question = input.value.trim();
    if (!question || controller) return;
    if (question.length > 600){ status.textContent = 'Maksimal 600 karakter per pertanyaan.'; return; }
    if (turns >= 20){ status.textContent = 'Percakapan sudah panjang. Pilih Percakapan baru untuk melanjutkan.'; return; }
    controller = new AbortController();
    busy(true); reset.hidden = false;
    var agentic = !modeBox.hidden && agenticInput.checked;
    message('user', question);
    var nextContext = null;
    var reply = message('assistant', '', agentic), text = '', sources = [], summary = null, done = false, usage = null, cacheHit = false, clarification = false;
    reply.block.insertBefore(progress, reply.content);
    reply.block.scrollIntoView?.({block: 'nearest'});
    status.textContent = 'Menghubungkan ke asisten arsip…';
    var started = Date.now(), ticker = setInterval(function(){
      elapsed.textContent = Math.floor((Date.now() - started) / 1000) + ' detik';
    }, 1000);
    var timeout = setTimeout(function(){ if (controller) controller.abort('timeout'); }, 9 * 60 * 1000);
    try {
      var response = await fetch(endpoint, {method: 'POST', signal: controller.signal,
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({question: question, context: context || undefined, mode: agentic ? 'agentic' : undefined})});
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
        if (event.type === 'status'){
          status.textContent = event.text;
          if (event.phase === 'answer'){ meter.removeAttribute('value'); activity.textContent = 'Asisten sedang menulis jawaban…'; }
        }
        if (event.type === 'progress'){
          meter.max = event.total; meter.value = event.completed;
          status.textContent = event.text; activity.textContent = event.text;
        }
        if (event.type === 'activity') activity.textContent = event.text;
        if (event.type === 'sources'){
          sources = event.sources.filter(function(s){
            return (/^D\d+$/.test(s.source_id) && knownPaths.has(s.path)) || (/^K\d+$/.test(s.source_id) && DATACAT.test(s.url || ''));
          });
          if (sources.length !== event.sources.length) throw new Error('Daftar arsip sudah diperbarui. Muat ulang halaman lalu coba lagi.');
          summary = sourceList(reply.block, sources);
        }
        if (event.type === 'delta'){
          text += event.text;
          if (text.length > 40000) throw new Error('Jawaban melampaui batas ukuran.');
          reply.content.textContent = text;
        }
        if (event.type === 'error') throw new Error(event.text);
        if (event.type === 'done'){
          if (!/^[a-f0-9]{64}$/.test(event.context || '')) throw new Error('Konteks jawaban tidak valid. Muat ulang halaman.');
          nextContext = event.context; done = true;
          usage = event.usage; cacheHit = !!event.cache_hit; clarification = !!event.clarification;
          if (summary) summary.textContent = sources.length + ' sumber dirujuk · lihat sumber';
          if (typeof event.agentic_left === 'number') showLeft(event.agentic_left);
        }
      }
      while (true){
        var part = await stream.read();
        pending += decoder.decode(part.value || new Uint8Array(), {stream: !part.done});
        var lines = pending.split('\n'); pending = lines.pop();
        if (pending.length > 100000 || lines.some(function(line){ return line.length > 100000; })) throw new Error('Aliran jawaban tidak valid.');
        lines.forEach(receive);
        if (part.done){ receive(pending); break; }
      }
      if (!done || !text.trim()) throw new Error('Jawaban terputus sebelum selesai. Silakan coba lagi.');
      renderAnswer(reply.content, text, sources);
      if (usage && typeof usage.known_cost_usd === 'number' && Number.isFinite(usage.known_cost_usd)){
        var cost = document.createElement('details'), costTitle = document.createElement('summary'), detail = document.createElement('p');
        costTitle.textContent = cacheHit ? 'Jawaban tersimpan · tanpa panggilan AI baru' : 'Pemakaian AI permintaan ini';
        detail.textContent = 'Biaya tercatat: US$' + usage.known_cost_usd.toFixed(6) +
          ' · Input: ' + Number(usage.prompt_tokens || 0).toLocaleString('id-ID') +
          ' token · Output: ' + Number(usage.completion_tokens || 0).toLocaleString('id-ID') +
          ' token · Input dari cache provider: ' + Number(usage.cached_tokens || 0).toLocaleString('id-ID') +
          ' token.' + (usage.missing_usage_calls ? ' Rincian biaya sebagian panggilan belum tersedia; angka ini belum total lengkap.' : '');
        cost.className = 'chat-sources'; cost.appendChild(costTitle); cost.appendChild(detail); reply.block.appendChild(cost);
      }
      context = nextContext; turns++;
      input.value = ''; input.placeholder = 'Tanyakan lanjutannya, misalnya: bagaimana risiko pendanaannya?';
      status.textContent = clarification ? 'Lengkapi tanggal untuk melanjutkan.' : 'Jawaban selesai berdasarkan ' + sources.length + ' sumber. Kamu bisa bertanya lagi.';
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
      if (agentic) loadConfig(); // a failed question may have been refunded
    } finally {
      clearTimeout(timeout); clearInterval(ticker); controller = null; busy(false); countInput();
      if (agenticLeft.textContent.indexOf('Sisa 0 ') === 0) agenticInput.disabled = true;
    }
  });

  stop.addEventListener('click', function(){ if (controller) controller.abort(); });
  reset.addEventListener('click', function(){
    if (controller) return;
    context = null; turns = 0; form.after(progress); log.replaceChildren(); status.textContent = ''; input.value = '';
    input.placeholder = 'Contoh: Analisis SOCI dari semua dokumen yang tersedia';
    reset.hidden = true; countInput(); input.focus();
  });
})();
