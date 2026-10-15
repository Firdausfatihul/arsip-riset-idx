
(function(){
  var data = JSON.parse(document.getElementById('arsip-data').textContent);

  var BUILD_VERSION = data.version || '';
  // Berkas build ini (bukan salinan lama di cache browser), sebagai 'json' atau 'text'.
  function fetchBuild(path, as){
    return fetch(path + '?v=' + encodeURIComponent(BUILD_VERSION), {cache: 'no-store'}).then(function(r){
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r[as]();
    });
  }
  // Pemuat yang mengambil satu berkas JSON sekali: ready(d) memvalidasi dan menyimpan datanya; yang gagal dicoba lagi pada panggilan berikutnya.
  function jsonOnce(path, ready){
    var loading = null;
    return function(){
      if (!loading) loading = fetchBuild(path, 'json').then(ready).catch(function(e){ loading = null; throw e; });
      return loading;
    };
  }
  // Pemeriksaan struktur data; setiap yang gagal melempar pesan msg.
  function checker(msg){
    var k = {require: function(ok){ if (!ok) throw new Error(msg); }};
    k.array = function(a, max){ k.require(Array.isArray(a) && a.length <= max); return a; };
    k.number = function(v){ k.require(v === null || (typeof v === 'number' && Number.isFinite(v))); };
    k.index = function(v, table){ k.require(Number.isSafeInteger(v) && v >= 0 && v < table.length); };
    k.flag = function(v){ k.require(v === 0 || v === 1); };
    k.url = function(v){ k.require(v === null || (typeof v === 'string' && v.length <= 4096)); };
    k.map = function(v){ return v != null && typeof v === 'object' && !Array.isArray(v); };
    return k;
  }

  fetch('version.json?t=' + Date.now(), {cache: 'no-store'})
    .then(function(r){ return r.json(); })
    .then(function(v){
      if (v.version && BUILD_VERSION && v.version !== BUILD_VERSION) {
        var url = new URL(location.href);
        url.searchParams.set('v', v.version);
        location.replace(url.toString());
      }
    })
    .catch(function(){});

  var docs = data.docs, byPath = Object.create(null), byName = Object.create(null);
  docs.forEach(function(d){
    byPath[d.path] = d; byName[d.name] = d;
    d.hay = [d.title, d.desc, d.label, d.catName, d.name].concat(d.tickers).join(' ').toLowerCase();
    d.body = (d.content || d.text || '').toLowerCase();
    // Daftar arsip tetap; simpan elemen sekali agar pencarian tidak memindai DOM laporan panjang berulang kali.
    d.listNodes = document.querySelectorAll('[data-id="' + d.id + '"]');
  });
  // Markdown/CSV besar diambil saat dibuka atau saat pencarian pertama.
  var lazyDocs = docs.filter(function(d){ return d.lazy; }), bulk = null;
  // Detail Stockbit (semua temuan per hari) tidak ikut diambil massal saat mencari; kodenya tetap tercari lewat d.tickers.
  var searchLazy = lazyDocs.filter(function(d){ return d.cat !== 'stockbit-detail'; });
  // Sama untuk detail BEI, dan dokumen yang dipensiunkan dari daftar (Digest Emiten): tetap bisa dibuka lewat #doc=, tidak ikut dicari.
  searchLazy = searchLazy.filter(function(d){ return d.cat !== 'bei-detail' && !d.unlisted; });
  var listedCount = docs.filter(function(d){ return !d.unlisted; }).length;
  function loadDoc(d){
    if (d.content != null) return Promise.resolve(d);
    if (!d.loading){
      d.loading = fetchBuild(d.path, 'text').then(function(t){
        d.content = t; d.body = t.toLowerCase(); d.failed = false; d.loading = null;
        return d;
      }, function(e){ d.failed = true; d.failedAt = Date.now(); d.loading = null; throw e; });
    }
    return d.loading;
  }
  function loadForSearch(){
    if (bulk) return;
    // Yang gagal dicoba lagi paling cepat 30 detik kemudian (dari file:// tiap percobaan pasti gagal).
    var queue = searchLazy.filter(function(d){ return d.content == null && (!d.failed || Date.now() - d.failedAt > 30000); });
    if (!queue.length) return;
    function worker(){
      var d = queue.shift();
      return d ? loadDoc(d).catch(function(){}).then(worker) : null;
    }
    bulk = Promise.all([worker(), worker(), worker()]).then(function(){ bulk = null; filter(); });
  }
  var app = document.querySelector('.app'), overview = document.getElementById('overview'),
      reader = document.getElementById('reader'), input = document.getElementById('cari'),
      note = document.getElementById('cari-catatan'), empty = document.getElementById('kosong');
  var sourceNav = document.querySelector('.category-nav'), clearSearch = document.getElementById('hapus-cari');
  var firstSource = sourceNav.querySelector('a');
  var selectedCategory = firstSource ? firstSource.getAttribute('data-cat') : '';
  var current = null, renderedQuery = null, siteTitle = document.title;
  var wideReading = window.matchMedia('(min-width: 1440px)');
  function syncContents(){
    reader.querySelectorAll('.toc-panel,.tick-wrap').forEach(function(el){ el.open = wideReading.matches; });
  }
  wideReading.addEventListener('change', syncContents);
  var DATE = '\\d{1,2}(?: [A-Z][a-z]+)?(?: \\d{4})?(?:–\\d{1,2}(?: [A-Z][a-z]+)?(?: \\d{4})?)?';
  var LABEL = /^([^:.<]{2,48}):\s+/, TICK = /^[A-Z]{4}$/, EMITEN = /^(?:(\d+(?:\.\d+)*)\.?\s+)?([A-Z]{4})(?:\s+[—–-]\s+(.+))?$/;

  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function slug(s){ return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'bagian'; }
  function docRoute(path, section){ return '#doc=' + encodeURIComponent(path).replace(/%2F/g, '/') + (section ? '&s=' + encodeURIComponent(section) : ''); }
  function kb(n){ return Math.round(n / 1024).toLocaleString('id-ID') + ' KB'; }
  function count(hay, q){ var n = 0, i = hay.indexOf(q); while (i !== -1 && n < 999){ n++; i = hay.indexOf(q, i + q.length); } return n; }

  function toHtml(md){
    if (window.marked && window.DOMPurify) {
      var clean = window.DOMPurify.sanitize(window.marked.parse(md, {gfm:true}), {
        ALLOWED_TAGS:['p','br','strong','em','del','blockquote','ul','ol','li','h1','h2','h3','h4','h5','h6','hr','pre','code','table','thead','tbody','tfoot','tr','th','td','a','details','summary','sup','sub','dl','dt','dd'],
        ALLOWED_ATTR:['href','title','colspan','rowspan'], ALLOW_DATA_ATTR:false, ALLOW_ARIA_ATTR:false,
        RETURN_DOM_FRAGMENT:true
      });
      clean.querySelectorAll('a').forEach(function(a){
        var href = a.getAttribute('href') || '';
        if (!/^(https?:\/\/|#)/i.test(href) || /[\u0000-\u0020\u007f]/.test(href)) a.removeAttribute('href');
      });
      var holder = document.createElement('div'); holder.appendChild(clean); return holder.innerHTML;
    }
    return null;
  }

  function csvHtml(text, delimiter){
    text = text.replace(/^\uFEFF/, '');
    var rows = [], row = [], cell = '', quoted = false, started = false;
    function endRow(){
      if (started || row.length || cell) { row.push(cell); rows.push(row); }
      row = []; cell = ''; started = false;
    }
    for (var i = 0; i < text.length; i++){
      var c = text[i];
      if (quoted){
        if (c === '"'){
          if (text[i + 1] === '"'){ cell += '"'; i++; } else quoted = false;
        } else cell += c;
      } else if (c === '"' && cell === '') { quoted = true; started = true; }
      else if (c === delimiter) { row.push(cell); cell = ''; started = true; }
      else if (c === '\n' || c === '\r'){
        endRow(); if (c === '\r' && text[i + 1] === '\n') i++;
      } else { cell += c; started = true; }
    }
    if (quoted) return '<p>CSV tidak terbaca: tanda kutip tidak ditutup.</p>';
    endRow();
    if (!rows.length) return '<p>File CSV kosong.</p>';
    return '<table tabindex="0" aria-label="Isi CSV"><thead><tr>' +
      rows[0].map(function(v, i){ return '<th scope="col"><button type="button" data-sort-col="' + i + '">' + esc(v) + '</button></th>'; }).join('') +
      '</tr></thead><tbody>' + rows.slice(1).map(function(r, n){
        return '<tr data-row="' + n + '">' + r.map(function(v){ return '<td>' + esc(v) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table>';
  }

  // Angka CSV: 1234, -1.5, 12,5, 1,234.5, 12%. Selain itu dibandingkan sebagai teks.
  function csvNumber(v){
    v = v.replace(/[\s%]/g, '');
    if (/^[-+]?(\d{1,3}(,\d{3})+)(\.\d+)?$/.test(v)) v = v.replace(/,/g, '');
    else if (/^[-+]?\d+,\d+$/.test(v)) v = v.replace(',', '.');
    return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(v) ? parseFloat(v) : null;
  }

  // Urutkan baris tabel CSV. Kolom angka mulai dari terbesar, kolom teks dari A; sel kosong selalu di bawah.
  // dir kosong = urutan asli file.
  function sortCsv(table, col, dir){
    var body = table.tBodies[0];
    if (!body) return;
    var rows = Array.prototype.slice.call(body.rows);
    var vals = rows.map(function(r){ var c = r.cells[col]; return c ? c.textContent.trim() : ''; });
    var nums = vals.map(csvNumber);
    var order = rows.map(function(_, i){ return i; });
    if (dir){
      var sign = dir === 'descending' ? -1 : 1;
      order.sort(function(a, b){
        var va = vals[a], vb = vals[b];
        if (!va || !vb) return (!va) - (!vb) || a - b;
        var na = nums[a], nb = nums[b], d;
        if (na !== null && nb !== null) d = na - nb;
        else if (na !== null || nb !== null) d = na !== null ? -1 : 1;
        else d = va.localeCompare(vb, 'id', {numeric: true, sensitivity: 'base'});
        return d * sign || a - b;
      });
    } else {
      order.sort(function(a, b){ return rows[a].getAttribute('data-row') - rows[b].getAttribute('data-row'); });
    }
    var frag = document.createDocumentFragment();
    order.forEach(function(i){ frag.appendChild(rows[i]); });
    body.appendChild(frag);
    Array.prototype.forEach.call(table.tHead.rows[0].cells, function(th, i){
      if (i === col && dir) th.setAttribute('aria-sort', dir); else th.removeAttribute('aria-sort');
    });
  }

  function csvIsNumeric(table, col){
    var seen = 0, num = 0;
    Array.prototype.some.call(table.tBodies[0] ? table.tBodies[0].rows : [], function(r){
      var v = r.cells[col] ? r.cells[col].textContent.trim() : '';
      if (v){ seen++; if (csvNumber(v) !== null) num++; }
      return seen >= 200;
    });
    return seen > 0 && num / seen >= 0.8;
  }

  function schedule(text){
    var parts = text.split(new RegExp('(?<=\\.)\\s+(?=' + DATE + ':\\s)'));
    if (parts.length < 3) return null;
    var rows = [];
    for (var i = 0; i < parts.length; i++){
      var m = parts[i].match(new RegExp('^(' + DATE + '):\\s+([\\s\\S]*)$'));
      if (!m) return null;
      rows.push('<li><time>' + esc(m[1]) + '</time><span>' + esc(m[2]) + '</span></li>');
    }
    return rows.join('');
  }

  // Rapikan hasil Markdown: bagian emiten, baris "Label: isi", jadwal, dan id untuk daftar isi.
  function enhance(root, doc){
    var used = Object.create(null), toc = [], emiten = [], section = null, dl = null;
    function uid(base){ var c = base, n = 2; while (used[c]){ c = base + '-' + n; n++; } used[c] = 1; return c; }
    function addEmiten(id, code){ if (!emiten.some(function(e){ return e[1] === code; })) emiten.push([id, code]); }
    var h1 = root.querySelector('h1');
    if (h1 && h1.textContent.trim() === doc.title) h1.remove();
    // Dokumen yang membagi bagian dengan "#" memakai H1 sebagai daftar isi; selain itu H2.
    var tocTag = root.querySelector('h1') ? 'H1' : 'H2';
    Array.prototype.slice.call(root.children).forEach(function(el){
      var tag = el.tagName;
      if (tag !== 'P') dl = null;
      if (tag === tocTag){
        section = null;
        var mt = el.textContent.trim().match(EMITEN);
        if (mt && !mt[1] && tag === 'H2'){
          // "## KODE" (digest per emiten): cukup masuk grid Emiten, tidak memenuhi daftar isi.
          el.id = uid(mt[2].toLowerCase());
          el.classList.add('emiten-top');
          el.innerHTML = '<span class="ticker">' + esc(mt[2]) + '</span>' + (mt[3] ? '<span>' + esc(mt[3]) + '</span>' : '');
          addEmiten(el.id, mt[2]);
          return;
        }
        if (mt && mt[1]){
          el.id = uid(mt[2].toLowerCase());
          el.classList.add('emiten-top');
          el.innerHTML = '<span class="emiten-no">' + esc(mt[1]) + '</span><span class="ticker">' + esc(mt[2]) + '</span>' + (mt[3] ? '<span>' + esc(mt[3]) + '</span>' : '');
          addEmiten(el.id, mt[2]);
        } else {
          el.id = uid(slug(el.textContent));
        }
        toc.push([el.id, el.textContent.trim()]);
        return;
      }
      if (/^H[1-6]$/.test(tag) && tag !== 'H3'){ section = null; el.id = uid(slug(el.textContent)); return; }
      if (tag === 'H3'){
        var m = el.textContent.trim().match(EMITEN);
        if (m){
          section = document.createElement('section');
          section.className = 'emiten';
          section.id = uid(m[2].toLowerCase());
          // Subbab bernomor sebelumnya memakai slug judul; pertahankan tujuan tautan lamanya.
          if (m[1] && m[1].indexOf('.') !== -1) el.id = uid(slug(el.textContent));
          el.parentNode.insertBefore(section, el);
          el.innerHTML = (m[1] ? '<span class="emiten-no">' + esc(m[1]) + '</span>' : '') +
            '<span class="ticker">' + esc(m[2]) + '</span>' + (m[3] ? '<span>' + esc(m[3]) + '</span>' : '');
          section.appendChild(el);
          addEmiten(section.id, m[2]);
          return;
        }
        section = null; el.id = uid(slug(el.textContent)); return;
      }
      if (section) section.appendChild(el);
      if (tag === 'P'){
        var rows = schedule(el.textContent.trim());
        if (rows){ var ol = document.createElement('ol'); ol.className = 'schedule'; ol.innerHTML = rows; el.replaceWith(ol); dl = null; return; }
        var lm = el.innerHTML.match(LABEL);
        if (lm && (section || TICK.test(lm[1]))){
          if (!dl){ dl = document.createElement('dl'); dl.className = 'facts'; el.parentNode.insertBefore(dl, el); }
          var row = document.createElement('div');
          row.innerHTML = '<dt>' + (TICK.test(lm[1]) ? '<span class="ticker">' + lm[1] + '</span>' : lm[1]) + '</dt>' +
            '<dd' + (/^rujukan/i.test(lm[1]) ? ' class="ref"' : '') + '>' + el.innerHTML.slice(lm[0].length) + '</dd>';
          dl.appendChild(row); el.remove(); return;
        }
        dl = null;
      }
      if (tag === 'UL' || tag === 'OL'){
        Array.prototype.forEach.call(el.children, function(li){
          var m2 = li.innerHTML.match(LABEL);
          if (m2 && m2[1].length <= 40) li.innerHTML = '<strong>' + m2[1] + ':</strong> ' + li.innerHTML.slice(m2[0].length);
        });
      }
    });
    root.querySelectorAll('td').forEach(function(td){
      var t = td.textContent.trim();
      if (!td.children.length && TICK.test(t)) td.innerHTML = '<span class="ticker">' + t + '</span>';
    });
    root.querySelectorAll('a[href^="http"]').forEach(function(a){ a.target = '_blank'; a.rel = 'noopener noreferrer'; });
    root.querySelectorAll('a[href^="#"]').forEach(function(a){
      var section = a.getAttribute('href').slice(1);
      if (!section || /^(doc|kepemilikan|emiten|pengguna)=/.test(section)) return;
      try { section = decodeURIComponent(section); } catch (e) { /* Pertahankan fragmen asli yang bukan URL-encoded. */ }
      a.setAttribute('href', docRoute(doc.path, section));
    });
    return {toc: toc, emiten: emiten};
  }

  function highlight(root, q){
    var doc = root.ownerDocument, walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [], node, total = 0, first = null;
    while ((node = walker.nextNode())){
      if (!/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/.test(node.parentNode.nodeName)) nodes.push(node);
    }
    var ql = q.toLowerCase();
    nodes.forEach(function(n){
      if (total >= 500) return;
      var text = n.nodeValue, low = text.toLowerCase(), i = low.indexOf(ql);
      if (i === -1) return;
      var frag = doc.createDocumentFragment(), pos = 0;
      while (i !== -1 && total < 500){
        frag.appendChild(doc.createTextNode(text.slice(pos, i)));
        var mk = doc.createElement('mark'); mk.className = 'arsip-hit'; mk.textContent = text.slice(i, i + q.length);
        frag.appendChild(mk); if (!first) first = mk; total++;
        pos = i + q.length; i = low.indexOf(ql, pos);
      }
      frag.appendChild(doc.createTextNode(text.slice(pos)));
      n.parentNode.replaceChild(frag, n);
    });
    return {total: total, first: first};
  }

  function hitNote(q, res){
    var hit = reader.querySelector('.hit-note');
    if (!hit) return;
    hit.hidden = q.length < 2;
    if (hit.hidden) return;
    if (res.total){
      hit.innerHTML = '<span>“' + esc(q) + '” muncul ' + (res.total >= 500 ? '500+' : res.total) + '× di dokumen ini</span>' +
        (res.first ? '<button type="button">Ke temuan pertama</button>' : '');
      if (res.first) hit.querySelector('button').addEventListener('click', function(){ res.first.scrollIntoView({behavior: 'instant', block: 'center'}); });
    } else {
      hit.textContent = '“' + q + '” tidak ada di dokumen ini';
    }
  }

  // Only the trusted report shell is same-origin; source HTML stays inside its opaque frame.
  function markFrame(frame, doc, q){
    var query = q.slice(0, 128);
    hitNote(query, {total:query.length >= 2 ? count(doc.body, query.toLowerCase()) : 0, first:null});
    renderedQuery = q;
    try {
      if (typeof frame.contentWindow.archiveFind !== 'function') return;
      frame.contentWindow.archiveFind(query).then(function(total){
        if (current !== doc || input.value.trim() !== q || total === null) return;
        hitNote(query, {total:total, first:total ? {scrollIntoView:function(){ frame.contentWindow.archiveJump(); }} : null});
      });
    } catch (e) { /* Text index remains available if the report cannot load. */ }
  }

  function tocHtml(info, doc){
    if (!info.toc.length && !info.emiten.length) return '';
    var h = '<nav class="toc" aria-label="Daftar isi"><details class="toc-panel"><summary>Daftar isi</summary>';
    if (info.toc.length) h += '<ol>' + info.toc.map(function(t){ return '<li><a href="' + docRoute(doc.path, t[0]) + '">' + esc(t[1]) + '</a></li>'; }).join('') + '</ol>';
    if (info.emiten.length) h += '<details class="tick-wrap"><summary>Emiten (' + info.emiten.length + ')</summary><div class="tick-grid">' +
      info.emiten.map(function(e){ return '<a class="chip" href="' + docRoute(doc.path, e[0]) + '">' + esc(e[1]) + '</a>'; }).join('') + '</div></details>';
    return h + '</details></nav>';
  }

  function renderDoc(doc, q){
    var meta = ['<span>' + esc(doc.name) + '</span>', '<span>' + kb(doc.size) + '</span>'];
    if (doc.kind === 'md'){
      meta.push('<span>' + doc.words.toLocaleString('id-ID') + ' kata</span>');
      if (doc.codes.length) meta.push('<span>' + doc.codes.length + ' emiten</span>');
    } else {
      (doc.stats || []).forEach(function(s){ meta.push('<span>' + esc(s) + '</span>'); });
    }
    meta.push('<a href="' + esc(doc.path) + '"' + (doc.kind === 'csv' ? ' download' : '') + '>' +
      (doc.kind === 'csv' ? 'Unduh CSV asli' : doc.kind === 'md' ? 'Buka .md mentah' : 'Buka halaman penuh') + '</a>');
    reader.setAttribute('data-cat', doc.cat);
    var head =
      '<nav class="crumbs" aria-label="Lokasi"><a href="#">← Daftar</a><span>/</span><span>' + esc(doc.catName) + '</span><span>/</span><span>' + esc(doc.label) + '</span></nav>' +
      '<header class="doc-head"><p class="kicker"><span class="swatch"></span>' + esc(doc.catName) + '<span>·</span><time datetime="' + doc.end + '">' + esc(doc.label) + '</time></p>' +
      '<h1>' + esc(doc.title) + '</h1><p class="meta">' + meta.join('') + '</p><p class="hit-note" hidden></p></header>';
    if (doc.kind === 'html'){
      // Laporan HTML ditampilkan utuh di dalam viewer, apa adanya.
      reader.innerHTML = head + '<iframe class="doc-frame" referrerpolicy="no-referrer" src="' + esc(doc.path) + '" title="' + esc(doc.title) + '"></iframe>';
      var frame = reader.querySelector('.doc-frame');
      frame.addEventListener('load', function(){ if (current === doc) markFrame(frame, doc, input.value.trim()); });
      current = doc; renderedQuery = q;
      return;
    }
    if (doc.content == null){
      reader.innerHTML = head + '<div class="doc-grid"><div class="prose"><p class="doc-loading">Memuat dokumen…</p></div></div>';
      current = doc; renderedQuery = q;
      if (doc.waiting) return;
      doc.waiting = true;
      loadDoc(doc).then(function(){
        doc.waiting = false;
        if (current !== doc || reader.hidden) return;
        renderDoc(doc, input.value.trim());
        jumpTo(doc, new URLSearchParams(location.hash.slice(1)).get('s'));
      }, function(){
        doc.waiting = false;
        if (current !== doc) return;
        reader.querySelector('.prose').innerHTML = '<div class="doc-loading" role="status"><p>Gagal memuat dokumen.</p>' +
          '<button type="button" data-retry-doc>Coba lagi</button> <a href="' + esc(doc.path) + '">Buka file</a></div>';
      });
      return;
    }
    reader.innerHTML = head + '<div class="doc-grid"><div class="prose"></div></div>';
    // Simpan hasil render agar pencarian tidak mengurai ulang dokumen besar.
    if (doc.html === undefined) doc.html = doc.kind === 'csv' ? csvHtml(doc.content, doc.delimiter) : toHtml(doc.content);
    var prose = reader.querySelector('.prose'), html = doc.html;
    if (html === null){
      prose.innerHTML = '<pre class="raw"></pre>';
      prose.firstChild.textContent = doc.content;
    } else if (doc.kind === 'csv'){
      prose.classList.add('csv');
      prose.innerHTML = html;
      var table = prose.querySelector('table');
      if (table && doc.sort) sortCsv(table, doc.sort.col, doc.sort.dir);
    } else {
      prose.innerHTML = html;
      var info = enhance(prose, doc);
      sbDecorate(prose, doc);
      beiDecorate(prose, doc);
      doc.codeMap = Object.create(null);
      info.emiten.forEach(function(e){ doc.codeMap[e[1].toLowerCase()] = e[0]; });
      prose.insertAdjacentHTML('beforebegin', tocHtml(info, doc));
      syncContents();
    }
    if (q.length >= 2) hitNote(q, highlight(prose, q));
    current = doc; renderedQuery = q;
  }

  function show(doc, section){
    var q = input.value.trim().slice(0,128), fresh = current !== doc;
    // .doc-loading masih tampil = dokumen besar belum/tidak jadi dirender (mis. ditinggal saat memuat): render ulang.
    if (fresh || (doc.kind !== 'html' && (renderedQuery !== q || reader.querySelector('.doc-loading')))) renderDoc(doc, q);
    overview.hidden = true; reader.hidden = false;
    // Dokumen unlisted (Digest Emiten lama lewat #doc=) tidak punya daftar sendiri: '← Daftar' kembali ke sumber yang ada.
    selectedCategory = doc.unlisted ? (listedCategory(selectedCategory) ? selectedCategory : homeCategory()) : doc.cat;
    markSource();
    document.title = doc.title + ' · ' + siteTitle;
    if (!jumpTo(doc, section) && fresh) window.scrollTo(0, 0);
  }

  function jumpTo(doc, section){
    if (!section) return false;
    var id = (doc.codeMap && doc.codeMap[section.toLowerCase()]) || section;
    var target = Array.prototype.find.call(reader.querySelectorAll('[id]'), function(el){ return el.id === id; });
    // Instan: animasi halus di dokumen sangat panjang bisa berhenti sebelum sampai.
    if (target) target.scrollIntoView({behavior: 'instant', block: 'start'});
    return !!target;
  }

  function listedCategory(cat){
    var el = cat && document.getElementById(cat);
    return !!(el && el.classList.contains('cat'));
  }
  function homeCategory(){
    if (listedCategory('bei-ringkasan')) return 'bei-ringkasan';
    var first = firstSource ? firstSource.getAttribute('data-cat') : '', cat = document.querySelector('#overview .cat');
    return listedCategory(first) ? first : cat ? cat.id : '';
  }
  function showOverview(){
    reader.hidden = true; overview.hidden = false;
    if (!listedCategory(selectedCategory)) selectedCategory = homeCategory();
    document.title = siteTitle;
    filter();
  }

  function setTab(name){
    document.querySelectorAll('.tabs [data-tab]').forEach(function(t){
      if (t.getAttribute('data-tab') === name) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
  }

  function route(){
    var p = new URLSearchParams(location.hash.slice(1));
    if (own && p.has('kepemilikan')){ showOwn(p); return; }
    var fromOwn = ownView && !ownView.hidden;
    if (ownView) ownView.hidden = true;
    app.hidden = false; setTab('docs');
    var doc = byPath[p.get('doc') || ''];
    var category = !doc && document.getElementById(location.hash.slice(1));
    if (category && category.classList.contains('cat')){
      selectedCategory = category.id;
      input.value = '';
      window.scrollTo(0, 0);
    }
    if (doc) show(doc, p.get('s'));
    else if (p.has('emiten') || p.has('pengguna')) showStockbit(p);
    else showOverview();
    if (fromOwn && !p.get('s')) window.scrollTo(0, 0);
  }

  function fmtNum(n){ return Number(n || 0).toLocaleString('id-ID'); }

  // ---- kepemilikan saham ---------------------------------------------------
  // Tab sendiri. Datanya (files/kepemilikan/kepemilikan.json dari tools/sync_idx.py) diambil saat tab pertama dibuka.
  // Hash: #kepemilikan=KODE&dari=YYYY-MM&sampai=YYYY-MM (tanpa dari = bulan KSEI pertama, tanpa sampai = bulan terakhir).
  // Bulan sebelum KSEI pertama hanya punya angka laporan emiten (free float, jumlah pemegang, pemegang ≥5%).
  var own = data.own, ownView = document.getElementById('own'), ownBody = document.getElementById('own-body'),
      ownSearch = document.getElementById('own-cari'), ownPick = document.getElementById('own-emiten'),
      ownFrom = document.getElementById('own-dari'), ownTo = document.getElementById('own-sampai');
  var ownData = null, ownState = {t: '', from: 0, to: 0, sort: 'besar', all: false, chartAll: true, refocus: null};
  var DEF_FROM = 0;
  if (own) for (var di = 0; di < own.months.length; di++) if (own.months[di].asOf){ DEF_FROM = di; break; }
  var BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  var ORIGIN = {L: 'Lokal', D: 'Lokal', F: 'Asing'};

  function num(v, digits){ return Number(v).toLocaleString('id-ID', {maximumFractionDigits: digits == null ? 2 : digits}); }
  function r2(v){ return Math.round(v * 100) / 100; }
  function pctText(v){ return v == null ? '—' : num(v) + '%'; }
  function countText(v){ return v == null ? '—' : num(v, 0); }
  function signed(d, digits, unit){ return (d > 0 ? '+' : '−') + num(Math.abs(d), digits) + (unit ? ' ' + unit : ''); }
  function poinText(d){ if (d == null) return '—'; d = r2(d); return d ? signed(d, 2, 'poin') : 'tetap'; }
  function tone(d){ return d == null || !r2(d) ? '' : (d > 0 ? 'up' : 'down'); }
  function monthName(i){ var p = own.months[i].p; return BULAN[+p.slice(5, 7) - 1] + ' ' + p.slice(0, 4); }
  // Tanggal data KSEI ("31 Agustus 2026"); short: "31 Agu 2026".
  function monthText(i, short){
    var d = own.months[i].asOf;
    if (!d) return monthName(i);
    var b = BULAN[+d.slice(5, 7) - 1];
    return +d.slice(8, 10) + ' ' + (short ? b.slice(0, 3) : b) + ' ' + d.slice(0, 4);
  }
  function safeUrl(u){ return /^https:\/\//.test(u || '') ? u : ''; }
  function ownHref(t, from, to){
    var h = '#kepemilikan=' + encodeURIComponent(t || '');
    if (from !== DEF_FROM) h += '&dari=' + own.months[from].p;
    if (to !== own.months.length - 1) h += '&sampai=' + own.months[to].p;
    return h;
  }
  function monthIdx(p, fallback){
    for (var i = 0; i < own.months.length; i++) if (own.months[i].p === p) return i;
    return fallback;
  }

  function validateOwn(d){
    var k = checker('Struktur data kepemilikan tidak valid.'), require = k.require, array = k.array, number = k.number,
        index = k.index, flag = k.flag, url = k.url;
    require(d && d.format === 6);  // 6 = identitas KSEI dan validasi sumber diperketat; jangan memakai cache format lama.
    array(d.months,240); require(d.months.length === own.months.length && d.months.length > 0);
    d.months.forEach(function(m,i){ require(m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m.p) && m.p === own.months[i].p); url(m.url); });
    [d.names,d.classes].forEach(function(a){ array(a,200000).forEach(function(v){ require(typeof v === 'string' && v.length <= 4000); }); });
    var seen = new Set(), count = 0;
    function rows(a, length, check){ array(a,200000).forEach(function(row){ require(Array.isArray(row) && row.length === length); require(++count <= 500000); check(row); }); }
    array(d.companies,5000).forEach(function(c){
      require(c && /^[A-Z0-9]{2,12}$/.test(c.t) && !seen.has(c.t) && typeof c.n === 'string' && c.n.length <= 4000); seen.add(c.t);
      require(typeof c.r === 'string' && c.r.length === d.months.length && /^[vx-]*$/.test(c.r));
      ['k','f','c','p'].forEach(function(key){
        array(c[key],240); require(c[key].length === d.months.length);
        c[key].forEach(function(v){
          if (v === null) return;
          if (key === 'k'){
            number(v.tp); rows(v.h,7,function(r){ require(Number.isSafeInteger(r[0]) && r[0] >= 0); index(r[1],d.names); index(r[2],d.classes); require(typeof r[3] === 'string'); r.slice(4).forEach(number); });
            if (v.i) array(v.i,1000).forEach(function(x){ require(typeof x === 'string'); });
          } else if (key === 'f'){
            require(Array.isArray(v) && v.length === 3); number(v[0]); flag(v[1]); array(v[2],1000).forEach(number);
          } else if (key === 'c'){
            require(Array.isArray(v) && v.length === 2); number(v[0]); flag(v[1]);
          } else {
            require(Array.isArray(v) && v.length === 3 && (v[2] === 'R' || v[2] === 'K' || v[2] === 'P')); number(v[0]); flag(v[1]); require(v[2] !== 'P' || v[1] === 0);
          }
        });
      });
    });
  }

  // Harga penutupan opsional: gagal dimuat atau tidak valid berarti indikator memakai lot, bukan rupiah.
  function loadPrices(d){
    if (!own.prices) return Promise.resolve();
    return fetchBuild(own.prices, 'json').then(function(p){
      var ok = p && p.format === 1 && Array.isArray(p.d) && p.d.length <= 240 && p.d.every(function(x){ return /^\d{4}-\d{2}-\d{2}$/.test(x); }) &&
        p.c && typeof p.c === 'object' && Object.keys(p.c).length <= 5000 && Object.keys(p.c).every(function(t){
          var v = p.c[t]; return /^[A-Z0-9]{2,12}$/.test(t) && Array.isArray(v) && v.length === p.d.length &&
            v.every(function(x){ return x === null || (typeof x === 'number' && Number.isFinite(x) && x > 0 && x < 1e9); });
        });
      if (ok) d.prices = {byDate: Object.create(null), c: p.c, src: typeof p.source === 'string' ? p.source.slice(0, 200) : ''};
      if (ok) p.d.forEach(function(x, i){ d.prices.byDate[x] = i; });
    }).catch(function(){});
  }
  // Harga penutupan as-of tanggal snapshot KSEI bulan i, atau null.
  function priceAt(t, i){
    var p = ownData && ownData.prices, day = own.months[i].asOf;
    if (!p || !day || p.byDate[day] == null || !p.c[t]) return null;
    return p.c[t][p.byDate[day]];
  }
  function rupiah(v){
    var a = Math.abs(v), u = a >= 1e12 ? [1e12, ' T'] : a >= 1e9 ? [1e9, ' M'] : a >= 1e6 ? [1e6, ' jt'] : a >= 1e3 ? [1e3, ' rb'] : [1, ''];
    return 'Rp' + num(v / u[0], u[0] === 1 ? 0 : a / u[0] >= 100 ? 0 : 1) + u[1];
  }
  var loadOwn = jsonOnce(own && own.path, function(d){
    validateOwn(d);
    d.byT = Object.create(null);
    d.companies.forEach(function(c){ d.byT[c.t] = c; c.hay = (c.t + ' ' + c.n).toLowerCase(); c.g = []; });
    ownPick.innerHTML = '<option value="">Semua emiten</option>' + d.companies.map(function(c){
      return '<option value="' + esc(c.t) + '">' + esc(c.t + (c.n ? ' · ' + c.n : '')) + '</option>';
    }).join('');
    ownData = d;
    return loadPrices(d).then(function(){ return d; });
  });

  // Laporan perubahan kepemilikan (formulir KSEI/IDX, surat BAE), berkas terpisah; diambil saat satu emiten dibuka.
  function validateChanges(d){
    var k = checker('Struktur laporan perubahan tidak valid.'), require = k.require, number = k.number;
    function text(v, max){ require(typeof v === 'string' && v.length <= max); }
    function day(v){ require(v === null || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))); }
    require(d && d.format === 1 && d.companies && typeof d.companies === 'object' && !Array.isArray(d.companies));
    var cov = d.coverage;
    require(cov == null || (typeof cov === 'object' && Number.isSafeInteger(cov.listed) && Number.isSafeInteger(cov.downloaded)));
    var keys = Object.keys(d.companies), count = 0;
    require(keys.length <= 5000);
    keys.forEach(function(t){
      require(/^[A-Z0-9]{2,12}$/.test(t));
      var rows = d.companies[t];
      require(Array.isArray(rows) && rows.length <= 20000);
      rows.forEach(function(r){
        require(Array.isArray(r) && r.length === 11 && ++count <= 300000);
        day(r[0]); text(r[1], 300); text(r[2], 200); r.slice(3, 7).forEach(number);
        require(Array.isArray(r[7]) && r[7].length <= 5000);  // satu formulir bisa mencantumkan ratusan transaksi harian
        r[7].forEach(function(x){ require(Array.isArray(x) && x.length === 5); text(x[0], 120); require(x[1] === null || x[1] === 1 || x[1] === -1 || x[1] === 0); number(x[2]); number(x[3]); day(x[4]); });
        require(r[8] === 0 || r[8] === 1);
        require(Array.isArray(r[9]) && r[9].length <= 50); r[9].forEach(function(x){ text(x, 400); });
        require(r[10] === null || (typeof r[10] === 'string' && r[10].length <= 4096));
      });
    });
  }
  var loadChanges = jsonOnce(own && own.changes, function(d){ validateChanges(d); return d; });

  // Daftar pemegang saham, jenis pemilik BAE, dan tautan laporan emiten (kepemilikan-laporan.json); diambil saat satu emiten dibuka.
  var reportsData = null;
  function validateReports(d){
    var k = checker('Struktur laporan emiten tidak valid.'), require = k.require, array = k.array, number = k.number,
        flag = k.flag, index = k.index, url = k.url;
    var n = own.months.length, count = 0;
    require(d && (d.format === 1 || d.format === 2) && /^https:\/\/[^\s]{1,200}$/.test(d.base) && d.companies && typeof d.companies === 'object' && !Array.isArray(d.companies));
    array(d.months, 240); require(d.months.length === n && d.months.every(function(m, i){ return m === own.months[i].p; }));
    [d.names, d.categories].forEach(function(a){ array(a, 200000).forEach(function(v){ require(typeof v === 'string' && v.length <= 4000); }); });
    function rows(a, length, check){ array(a, 200000).forEach(function(row){ require(Array.isArray(row) && row.length === length); require(++count <= 2000000); check(row); }); }
    var keys = Object.keys(d.companies);
    require(keys.length <= 5000);
    keys.forEach(function(t){
      var c = d.companies[t];
      require(/^[A-Z0-9]{2,12}$/.test(t) && c && typeof c === 'object');
      if (c.d !== undefined){
        array(c.d, n); array(c.u, n); require(c.d.length === n && c.u.length === n);
        c.d.forEach(function(v, i){
          if (v === null) return;
          if (typeof v === 'number'){ require(Number.isSafeInteger(v) && v >= 0 && v < i && c.d[v] && typeof c.d[v] === 'object'); return; }
          require(typeof v === 'object'); number(v.s); if (v.v !== undefined) flag(v.v);
          // Format 2: v = laporan derivable(), baris ke-6 = 1 boleh diturunkan / 2 agregat / 0 lainnya (report_holders di tools/sync_idx.py).
          rows(v.h, d.format === 2 ? 6 : 5, function(r){ index(r[0], d.names); r.slice(1, 4).forEach(number); flag(r[4]); require(r.length === 5 || r[5] === 0 || r[5] === 1 || r[5] === 2); });
        });
        c.u.forEach(function(v){ require(v === null || (typeof v === 'string' && v.length <= 4096 && (/^https:\/\//.test(v) || /^[A-Za-z0-9_.\/-]+$/.test(v)))); });
      }
      if (c.b !== undefined){
        array(c.b, n); require(c.b.length === n);
        c.b.forEach(function(v){
          if (v === null) return;
          url(v.u); rows(v.r, 6, function(r){ require(typeof r[0] === 'string'); index(r[1], d.categories); r.slice(2, 5).forEach(number); flag(r[5]); });
          rows(v.t, 4, function(r){ require(typeof r[0] === 'string'); r.slice(1).forEach(number); });
        });
      }
    });
  }
  var loadReports = jsonOnce(own && own.reports, function(d){ validateReports(d); d.decoded = Object.create(null); return (reportsData = d); });
  // Laporan satu emiten: d = daftar pemegang per bulan ({h, s, u}; nomor bulan = daftar persis sama dengan bulan itu), b = jenis pemilik.
  function reportsFor(t){
    var d = reportsData, out = d.decoded[t];
    if (out) return out;
    var raw = d.companies[t] || {}, n = own.months.length;
    function link(u){ return !u ? null : /^https:\/\//.test(u) ? u : d.base + u; }
    out = {d: [], b: raw.b || series(function(){ return null; }, 1, n), u: []};
    for (var i = 0; i < n; i++){
      var v = raw.d ? raw.d[i] : null, u = raw.u ? link(raw.u[i]) : null;
      if (typeof v === 'number') v = raw.d[v];
      out.u.push(u);
      out.d.push(v ? {h: v.h, s: v.s, v: v.v, u: u} : null);
    }
    return (d.decoded[t] = out);
  }

  // Pemegang satu emiten di satu bulan, dijumlahkan per investor (nomor investor sama lintas bulan).
  function groupsAt(c, i){
    if (c.g[i] !== undefined) return c.g[i];
    var k = c.k[i], g = null;
    if (k){
      g = Object.create(null);
      k.h.forEach(function(r){
        var x = g[r[0]];
        if (!x){ g[r[0]] = {name: ownData.names[r[1]], cls: ownData.classes[r[2]], lf: r[3], pct: r[4], total: r[5], rows: r[6]}; return; }
        x.pct = x.pct == null || r[4] == null ? null : x.pct + r[4];
        x.total = x.total == null || r[5] == null ? null : x.total + r[5];
        x.rows += r[6];
      });
    }
    return (c.g[i] = g);
  }
  function tpAt(c, i){ return c.k[i] && c.k[i].tp != null ? c.k[i].tp : null; }
  function restAt(c, i){ var t = tpAt(c, i); return t == null ? null : r2(100 - t); }
  function kseiIssues(c, i){
    var k = c.k[i];
    if (!own.months[i].asOf || !k) return ['snapshot KSEI >1% belum tersedia'];
    var issues = (k.i || []).slice();
    if (!k.h.length && !issues.length) issues.push('tanpa baris pemegang');
    if (k.tp == null && k.h.length && !issues.length) issues.push('akumulasi KSEI belum terbaca');
    if (k.tp != null && (k.tp < 0 || k.tp > 100.05)) issues.push('akumulasi KSEI di luar 0–100%');
    var ids = new Set(), duplicate = false, badPct = false, badShares = false;
    k.h.forEach(function(r){
      if (ids.has(r[0])) duplicate = true;
      ids.add(r[0]);
      if (r[4] != null && (r[4] < 0 || r[4] > 100.05)) badPct = true;
      if (r[5] != null && (!Number.isSafeInteger(r[5]) || r[5] < 0)) badShares = true;
    });
    if (duplicate) issues.push('identitas investor berulang');
    if (badPct) issues.push('porsi investor di luar 0–100%');
    if (badShares) issues.push('lembar investor tidak valid');
    return issues;
  }
  function tpOk(c, i){ return kseiIssues(c, i).length === 0; }
  function kseiPairOk(c, from, to){ return tpOk(c, from) && tpOk(c, to); }
  function kseiPairNote(c, from, to){
    return (from === to ? [to] : [from, to]).map(function(i){
      var issues = kseiIssues(c, i);
      return issues.length ? esc(monthText(i)) + ': ' + esc(issues.join('; ')) : '';
    }).filter(Boolean).join('. ');
  }
  function ffAt(c, i){ return c.f[i] ? c.f[i][0] : null; }
  function b5At(c, i){ return c.p[i] ? c.p[i][0] : null; }
  function okAt(list, i){ return !!(list[i] && list[i][1]); }
  function countAt(c, i){ return c.c[i] ? c.c[i][0] : null; }
  function holdersAt(c, i){ var g = groupsAt(c, i); return g && Object.keys(g).length ? Object.keys(g).length : null; }
  var ROLES = [[1, '≥5%'], [2, 'Pengendali'], [4, 'Afiliasi'], [8, 'Direksi'], [16, 'Komisaris']];
  function roleText(mask){ return ROLES.filter(function(r){ return mask & r[0]; }).map(function(r){ return r[1]; }).join(' · ') || '—'; }
  function shortMonth(i){ var p = own.months[i].p; return BULAN[+p.slice(5, 7) - 1].slice(0, 3) + ' ' + p.slice(0, 4); }
  function sourceLink(url, text){ return safeUrl(url) ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + text + '</a>' : ''; }
  // Laporan emiten sering terbit sebulan setelah data KSEI: pakai laporan terakhir sampai bulan i.
  function latestAt(list, i){ if (!list) return null; for (; i >= 0; i--) if (list[i]) return i; return null; }
  // Pasangan laporan untuk rentang Dari–Sampai: terakhir sampai Sampai, dibanding terakhir sampai Dari
  // (atau laporan paling awal di dalam rentang kalau sebelum Dari belum ada).
  function reportPair(list, from, to){
    var cur = latestAt(list, to), cmp = cur == null ? null : latestAt(list, from);
    if (cur != null && cmp == null) for (var i = from + 1; i < cur; i++) if (list[i]){ cmp = i; break; }
    return {cur: cur, cmp: cmp === cur ? null : cmp};
  }
  function lastCell(list, i, fmt){
    var j = latestAt(list, i);
    return j == null ? '—' : fmt(list[j][0]) + (j === i ? '' : ' <span class="own-tags">' + esc(shortMonth(j)) + '</span>');
  }
  // Jumlah pemegang saham (laporan emiten) di rentang: {cur, cmp, d (selisih), pct (persen perubahan)}.
  function countChange(c, from, to){
    var pr = reportPair(c.c, from, to), cur = pr.cur == null ? null : c.c[pr.cur][0], cmp = pr.cmp == null ? null : c.c[pr.cmp][0];
    // Jumlah 0 berarti angkanya salah baca, bukan emiten tanpa pemegang: tidak dihitung sebagai perubahan.
    var valid = cur > 0 && cmp > 0 && okAt(c.c, pr.cur) && okAt(c.c, pr.cmp);
    return {pair: pr, cur: cur, cmp: cmp, d: valid ? cur - cmp : null, pct: valid ? (cur - cmp) / cmp * 100 : null};
  }
  function series(fn, from, to){ var v = []; for (var i = from; i <= to; i++) v.push(fn(i)); return v; }

  function spark(vals){
    var w = 96, h = 26, nums = vals.filter(function(v){ return v != null; });
    if (vals.length < 2 || !nums.length) return '';
    var lo = Math.min.apply(null, nums), hi = Math.max.apply(null, nums), d = '', dots = '', pen = false;
    if (hi - lo < 0.02){ lo -= 1; hi += 1; }
    vals.forEach(function(v, i){
      if (v == null){ pen = false; return; }
      var x = (3 + i * (w - 6) / (vals.length - 1)).toFixed(1), y = (h - 3 - (v - lo) / (hi - lo) * (h - 6)).toFixed(1);
      d += (pen ? 'L' : 'M') + x + ' ' + y; pen = true;
      if (i === 0 || i === vals.length - 1 || (vals[i - 1] == null && vals[i + 1] == null)) dots += '<circle cx="' + x + '" cy="' + y + '" r="2"/>';
    });
    return '<svg class="own-spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true"><path d="' + d + '"/>' + dots + '</svg>';
  }

  function showOwn(p){
    var st = ownState, last = own.months.length - 1, prevT = st.t, wasHidden = ownView.hidden;
    st.t = (p.get('kepemilikan') || '').trim().toUpperCase();
    st.from = monthIdx(p.get('dari'), DEF_FROM); st.to = monthIdx(p.get('sampai'), last);
    if (st.from > st.to){ var swap = st.from; st.from = st.to; st.to = swap; }
    app.hidden = true; ownView.hidden = false; setTab('own');
    ownFrom.value = String(st.from); ownTo.value = String(st.to);
    document.title = (st.t ? st.t + ' · ' : '') + 'Kepemilikan saham · ' + siteTitle;
    if (wasHidden || prevT !== st.t) window.scrollTo(0, 0);
    if (ownData){ renderOwn(); return; }
    ownBody.innerHTML = '<p class="doc-loading">Memuat data kepemilikan…</p>';
    loadOwn().then(renderOwn, function(){
      if (ownView.hidden) return;
      ownBody.innerHTML = '<div class="doc-loading" role="status"><p>Data kepemilikan gagal dimuat.</p>' +
        '<button type="button" id="own-retry">Coba lagi</button></div>';
    });
  }

  function renderOwn(){
    if (ownView.hidden || !ownData) return;
    var st = ownState, c = st.t ? ownData.byT[st.t] : null;
    ownPick.value = c ? c.t : '';
    if (c){
      ownBody.innerHTML = detailHtml(c);
      trendChart(document.getElementById('own-trend'), c);
      if (own.reports) fillReports(c);
      if (own.changes) fillChanges(c);
    } else {
      ownBody.innerHTML = (st.t ? '<p class="own-note">Kode ' + esc(st.t) + ' tidak ada. Pilih dari daftar.</p>' : '') + listHtml();
    }
  }

  function listHtml(){
    var st = ownState, raw = ownSearch.value.trim(), q = raw.toLowerCase(), same = st.from === st.to, rows = [];
    ownData.companies.forEach(function(c){
      if (q && c.hay.indexOf(q) === -1) return;
      var a = tpAt(c, st.from), b = tpAt(c, st.to);
      rows.push({c: c, a: a, b: b, d: kseiPairOk(c, st.from, st.to) ? r2(b - a) : null, hc: countChange(c, st.from, st.to)});
    });
    var score = {
      besar: function(r){ return r.d == null ? -1 : Math.abs(r.d); },
      naik: function(r){ return r.d == null ? -1e9 : r.d; },
      turun: function(r){ return r.d == null ? -1e9 : -r.d; },
      'pemegang-naik': function(r){ return r.hc.pct == null ? -1e9 : r.hc.pct; },
      'pemegang-turun': function(r){ return r.hc.pct == null ? -1e9 : -r.hc.pct; }
    }[st.sort === 'kode' || (same && st.sort.indexOf('pemegang') !== 0) ? 'kode' : st.sort];
    rows.sort(function(x, y){ return (score ? score(y) - score(x) : 0) || (x.c.t < y.c.t ? -1 : 1); });
    var sorts = [['besar', 'Akumulasi >1%: perubahan terbesar'], ['naik', 'Akumulasi >1%: naik'], ['turun', 'Akumulasi >1%: turun'],
                 ['pemegang-naik', 'Jumlah pemegang: naik (%)'], ['pemegang-turun', 'Jumlah pemegang: turun (%)'], ['kode', 'Kode']];
    var h = '<section class="own-card"><div class="own-card-head"><h3>' +
      (same ? 'Akumulasi &gt;1%, ' + esc(monthText(st.to)) : 'Akumulasi &gt;1%, ' + esc(monthText(st.from)) + ' → ' + esc(monthText(st.to))) + '</h3>' +
      '<label class="own-field own-inline">Urutkan<select id="own-urut">' + sorts.map(function(o){
        return '<option value="' + o[0] + '"' + (o[0] === st.sort ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select></label></div>';
    if (!rows.length) return h + '<p class="empty">Tidak ada emiten “' + esc(raw) + '”.</p></section>';
    var shown = st.all || q ? rows : rows.slice(0, 100);
    h += '<div class="own-scroll"><table class="own-table"><thead><tr><th scope="col">Emiten</th>' +
      (same ? '' : '<th scope="col">' + esc(monthText(st.from, true)) + '</th>') + '<th scope="col">' + esc(monthText(st.to, true)) + '</th>' +
      (same ? '' : '<th scope="col">Perubahan</th>') + '<th scope="col">Pemegang &gt;1%</th><th scope="col">Jumlah pemegang</th><th scope="col">Free float resmi</th>' +
      (same ? '' : '<th scope="col">Tren</th>') + '</tr></thead><tbody>' +
      shown.map(function(r){
        var c = r.c;
        return '<tr><th scope="row"><a class="own-code" href="' + ownHref(c.t, st.from, st.to) + '"><span class="ticker">' + esc(c.t) + '</span>' +
          (c.n ? '<span class="own-name">' + esc(c.n) + '</span>' : '') + '</a></th>' +
          (same ? '' : '<td>' + pctText(r.a) + '</td>') + '<td><strong>' + pctText(r.b) + '</strong></td>' +
          (same ? '' : '<td class="' + tone(r.d) + '">' + poinText(r.d) + (kseiPairOk(c, st.from, st.to) ? '' : '<span class="own-tags">tidak dibandingkan</span>') + '</td>') +
          '<td>' + countText(holdersAt(c, st.to)) + '</td><td>' + lastCell(c.c, st.to, countText) +
          (r.hc.pct != null ? '<span class="own-tags ' + tone(r.hc.d) + '">' + (r.hc.d ? signed(r.hc.pct, 1) + '% vs ' + esc(shortMonth(r.hc.pair.cmp)) : 'tetap vs ' + esc(shortMonth(r.hc.pair.cmp))) + '</span>' : '') +
          '</td><td>' + lastCell(c.f, st.to, pctText) + '</td>' +
          (same ? '' : '<td>' + spark(series(function(i){ return tpOk(c, i) ? tpAt(c, i) : null; }, st.from, st.to)) + '</td>') + '</tr>';
      }).join('') + '</tbody></table></div>';
    if (shown.length < rows.length) h += '<p class="own-more"><button type="button" id="own-semua">Tampilkan semua ' + rows.length + ' emiten</button></p>';
    return h + '<p class="own-note">' + rows.length + ' emiten' + (q ? ' cocok' : '') + '. Akumulasi &gt;1%: total porsi pemegang &gt;1% (KSEI). ' +
      'Jumlah pemegang dan free float: laporan emiten terakhir sampai ' + esc(monthName(st.to)) + '; perubahan jumlah pemegang vs laporan sampai ' + esc(monthName(st.from)) + '.' +
      (own.months[st.from].asOf ? '' : ' Data KSEI &gt;1% mulai ' + esc(monthText(DEF_FROM)) + '; kolom ' + esc(monthName(st.from)) + ' kosong, bukan nol.') + '</p></section>';
  }

  function investors(c, from, to){
    var gf = groupsAt(c, from) || {}, gt = groupsAt(c, to) || {}, seen = Object.create(null), rows = [], valid = kseiPairOk(c, from, to);
    Object.keys(gt).concat(Object.keys(gf)).forEach(function(inv){
      if (seen[inv]) return;
      seen[inv] = true;
      var a = gf[inv], b = gt[inv], d = valid && a && b && a.pct != null && b.pct != null ? r2(b.pct - a.pct) : null;
      var ds = valid && a && b && a.total != null && b.total != null ? b.total - a.total : null;
      // Absen dari daftar ambang >1% bukan nol; jangan menggambar delta tanpa kedua angka.
      rows.push({inv: inv, a: a, b: b, cur: b || a, d: d, ds: ds,
                 status: !valid || from === to ? '' : (!a ? 'baru' : (!b ? 'keluar' : ''))});
    });
    return rows;
  }

  // Struktur pemegang: indikator turunan dari KSEI >1% dan laporan emiten. Deskriptif; belum diuji terhadap harga.
  // Rekening kustodian/nominee (dari tools/ksei_signals.py) menampung banyak pemilik, jadi tidak dihitung sebagai blok.
  var NOMINEE_RE = __NOMINEE_RE__;
  var CUSTODIAN_RE = __CUSTODIAN_RE__;
  function pooled(name){ var u = String(name || '').toUpperCase(); return NOMINEE_RE.test(u) || CUSTODIAN_RE.test(u); }
  // Jumlah pemegang terverifikasi terakhir sampai bulan i (maks. 2 bulan ke belakang); hitungan 0 dianggap tidak ada, null bila tidak ditemukan.
  function holderCount(c, i){
    for (var j = i; j >= Math.max(0, i - 2); j--) if (c.c[j] && c.c[j][1] && c.c[j][0] > 0) return {n: c.c[j][0], i: j};
    return null;
  }
  // Total saham tersirat dari baris KSEI (lembar / persen), median antarbaris.
  function impliedShares(g){
    var v = Object.keys(g).map(function(k){ return g[k].pct > 0 && g[k].total > 0 ? g[k].total / g[k].pct * 100 : null; }).filter(Boolean).sort(function(x, y){ return x - y; });
    return v.length ? v[Math.floor(v.length / 2)] : null;
  }
  function structAt(c, i){
    if (!tpOk(c, i)) return null;
    var g = groupsAt(c, i), keys = Object.keys(g || {});
    if (!keys.length) return null;
    var tp = tpAt(c, i), hhi = 0, top = 0, shadow = 0, shadowN = 0;
    keys.forEach(function(k){ var p = g[k].pct || 0; hhi += p * p; top = Math.max(top, p); if (p >= 1 && p < 5 && !pooled(g[k].name)){ shadow += p; shadowN++; } });
    var hc = holderCount(c, i), ff = null;
    for (var j = i; j >= Math.max(0, i - 2); j--) if (c.f[j] && c.f[j][1]){ ff = {v: c.f[j][0], i: j}; break; }
    var s = {n: keys.length, tp: tp, rest: r2(100 - tp), hhi: hhi, eff: hhi > 0 ? 10000 / hhi : null, top: top, hc: hc, ff: ff, shadow: shadow, shadowN: shadowN, shares: impliedShares(g)};
    if (hc && hc.n > s.n){ s.nRest = hc.n - s.n; s.avg = s.rest / s.nRest; s.avgShares = s.shares ? s.shares * s.rest / 100 / s.nRest : null; }
    if (ff) s.gap = r2(ff.v - s.rest);
    return s;
  }
  // Perubahan jumlah pemegang k bulan (kedua ujung terverifikasi, tepat k bulan).
  function breadthAt(c, i, k){
    var a = c.c[i - k], b = c.c[i];
    return a && b && a[1] && b[1] && a[0] > 0 && b[0] > 0 ? b[0] / a[0] - 1 : null;
  }
  // Nilai pembanding seluruh emiten per bulan, dihitung sekali.
  function marketAt(i){
    ownData.market = ownData.market || {};
    if (ownData.market[i]) return ownData.market[i];
    var m = {tp: [], hhi: [], gap: [], b3: []};
    ownData.companies.forEach(function(c){
      var x = structAt(c, i), b = breadthAt(c, i, 3);
      if (x){ m.tp.push(x.tp); m.hhi.push(x.hhi); if (x.gap != null) m.gap.push(x.gap); }
      if (b != null) m.b3.push(b);
    });
    Object.keys(m).forEach(function(k){ m[k].sort(function(x, y){ return x - y; }); });
    return (ownData.market[i] = m);
  }
  // Persen emiten dengan nilai lebih kecil (seri dihitung setengah).
  function rankPct(arr, v){
    if (!arr.length || v == null) return null;
    var lo = 0, eq = 0;
    arr.forEach(function(x){ if (x < v) lo++; else if (x === v) eq++; });
    return Math.round((lo + eq / 2) / arr.length * 100);
  }
  function rankText(p, more, less){ return p == null ? '' : p >= 50 ? more + ' dari ' + p + '% emiten' : less + ' dari ' + (100 - p) + '% emiten'; }
  // Akumulasi/distribusi Dari–Sampai: perubahan lembar pemegang >1% yang sama (tanpa kustodian) vs perubahan jumlah pemegang.
  function flowAt(c, from, to){
    if (from === to || !kseiPairOk(c, from, to)) return null;
    var ga = groupsAt(c, from) || {}, gb = groupsAt(c, to) || {}, sb = impliedShares(gb), na = holderCount(c, from), nb = holderCount(c, to);
    if (!sb || !na || !nb || na.i === nb.i) return null;
    var d = 0, matched = 0;
    Object.keys(gb).forEach(function(k){
      var a = ga[k], b = gb[k];
      if (a && b && a.total != null && b.total != null && !pooled(b.name)){ d += (b.total - a.total) / sb * 100; matched++; }
    });
    if (!matched) return null;
    var dn = nb.n / na.n - 1, kind = d >= 1 && dn <= -0.05 ? 'akumulasi' : d <= -1 && dn >= 0.05 ? 'distribusi' : 'netral';
    return {block: r2(d), dn: dn, kind: kind};
  }
  var HHI_TIP = 'Herfindahl-Hirschman Index: jumlah kuadrat porsi tiap pemegang >1%. 10.000 = satu pemilik 100%; 5.000 = dua pemegang 50%; 1.000 = sepuluh pemegang 10%. ' +
    'Setara N pemegang = 10.000 ÷ HHI. Hanya pemegang >1%, jadi batas bawah; pemegang terafiliasi yang tercatat terpisah membuatnya tampak lebih rendah.';
  function structHtml(c, from, to){
    var x = structAt(c, to);
    var h = '<section class="own-card"><div class="own-card-head"><h3>Struktur pemegang</h3><span>per ' + esc(monthText(to)) + '</span></div>';
    if (!x) return h + '<p class="own-note">Butuh snapshot KSEI &gt;1% yang valid di bulan Sampai.</p></section>';
    var m = marketAt(to), rows = [];
    function pc(v){ return num(v * 100, 1) + '%'; }
    rows.push(['Pemegang &gt;1%', '<b>' + x.n + ' pemegang = ' + pctText(x.tp) + '</b> <span class="own-tags">' + rankText(rankPct(m.tp, x.tp), 'lebih terkonsentrasi', 'lebih tersebar') + '</span>']);
    rows.push(['Sisa', x.nRest ? '<b>' + pctText(x.rest) + '</b> dipegang ±' + countText(x.nRest) + ' pihak · rata-rata ' + num(x.avg, 4) + '%' +
      (x.avgShares ? (priceAt(c.t, to) ? ' (±' + rupiah(x.avgShares * priceAt(c.t, to)) + ')' : ' (±' + countText(Math.round(x.avgShares / 100)) + ' lot)') : '') + ' per pihak' +
      (x.avgShares && priceAt(c.t, to) ? ' <span class="own-tags">harga ' + num(priceAt(c.t, to), 0) + ' per ' + esc(monthText(to, true)) + '</span>' : '') +
      (x.hc.i !== to ? ' <span class="own-tags">jumlah pemegang ' + esc(monthName(x.hc.i)) + '</span>' : '')
      : '<b>' + pctText(x.rest) + '</b> <span class="own-tags">jumlah pemegang terverifikasi belum ada</span>']);
    rows.push(['<span class="own-info" tabindex="0" data-tip="' + esc(HHI_TIP) + '" aria-label="HHI: ' + esc(HHI_TIP) + '">HHI</span>', '<b>' + countText(Math.round(x.hhi)) + '</b> · setara ±' + num(x.eff, 1) + ' pemegang sama besar · terbesar ' + pctText(x.top) +
      ' <span class="own-tags">' + rankText(rankPct(m.hhi, x.hhi), 'lebih tinggi', 'lebih rendah') + '</span>']);
    if (x.gap != null) rows.push(['Free float', 'resmi <b>' + pctText(x.ff.v) + '</b>, di luar pemegang &gt;1% <b>' + pctText(x.rest) + '</b>' +
      (x.rest < 7.5 ? '<span class="own-badge">float riil &lt; 7,5%</span>' : '') +
      (x.gap > 0.5 ? ' · selisih ' + num(x.gap, 2) + ' poin, ' + x.shadowN + ' pemegang 1–5% di luar kustodian memegang ' + pctText(r2(x.shadow)) +
        ' <span class="own-tags">' + rankText(rankPct(m.gap, x.gap), 'selisih lebih besar', 'selisih lebih kecil') + '</span>' :
        x.gap < -1 ? ' <span class="own-tags">tidak sinkron (tanggal/definisi berbeda)</span>' : '') +
      (x.ff.i !== to ? ' <span class="own-tags">free float ' + esc(monthName(x.ff.i)) + '</span>' : '')]);
    var bs = [1, 3, 6, 12].map(function(k){ var b = breadthAt(c, to, k); return b == null ? null : k + ' bln ' + (b > 0 ? '+' : b < 0 ? '−' : '') + pc(Math.abs(b)); }).filter(Boolean);
    var b3 = breadthAt(c, to, 3);
    if (bs.length) rows.push(['Jumlah pemegang', bs.join(' · ') + (b3 != null ? ' <span class="own-tags">3 bln ' + rankText(rankPct(m.b3, b3), 'lebih tinggi', 'lebih rendah') + '</span>' : '')]);
    var f = flowAt(c, from, to);
    if (f) rows.push(['Akumulasi / distribusi', 'blok &gt;1% ' + (f.block > 0 ? '+' : f.block < 0 ? '−' : '') + num(Math.abs(f.block), 2) + ' poin · pemegang ' +
      (f.dn > 0 ? '+' : f.dn < 0 ? '−' : '') + pc(Math.abs(f.dn)) + ' → <b>' + (f.kind === 'netral' ? 'netral' : 'pola ' + f.kind) + '</b>' +
      ' <span class="own-tags">' + esc(monthText(from, true)) + ' → ' + esc(monthText(to, true)) + '</span>']);
    h += '<dl class="own-struct">' + rows.map(function(r){ return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl>';
    return h + '<p class="own-note">Deskriptif, belum diuji terhadap harga. Jumlah pemegang menghitung rekening; rekening kustodian dihitung satu. ' +
      'Akumulasi: blok pemegang &gt;1% yang sama naik ≥1 poin dan pemegang turun ≥5% (distribusi sebaliknya); bukan bukti transaksi.</p></section>';
  }

  function tile(key, label, value, sub){
    return '<div class="own-tile"><div class="own-tile-label">' + (key ? '<span class="own-key ' + key + '"></span>' : '') + label + '</div>' +
      '<div class="own-tile-value">' + value + '</div><div class="own-tile-delta">' + sub + '</div></div>';
  }

  function detailHtml(c){
    var st = ownState, from = st.from, to = st.to, same = from === to, vs = ' vs ' + esc(monthText(from, true)), comparable = kseiPairOk(c, from, to);
    function delta(a, b, fmt){
      if (!tpOk(c, to) || (!same && !comparable)) return 'tidak dibandingkan';
      if (same) return 'per ' + esc(monthText(to));
      if (a == null || b == null) return 'tanpa data per ' + esc(monthText(from, true));
      return '<span class="' + tone(b - a) + '">' + fmt(b - a) + '</span>' + vs;
    }
    function countDelta(d){ return d ? signed(d, 0) : 'tetap'; }
    // Pemegang ≥5%: dari daftar laporan emiten bulan itu, atau baris KSEI ≥5% kalau laporannya tidak terbaca.
    function b5Tile(){
      var pr = reportPair(c.p, from, to);
      if (pr.cur == null) return tile('s5', 'Pemegang ≥5%', '—', 'laporan emiten sampai ' + esc(monthName(to)) + ' belum terbaca');
      var a = pr.cmp == null ? null : c.p[pr.cmp][0], v = c.p[pr.cur];
      return tile('s5', 'Pemegang ≥5%', pctText(r2(v[0])), (v[2] === 'K' ? 'KSEI ≥5% ' : v[2] === 'P' ? 'persen tertulis ' : 'laporan ') + esc(monthName(pr.cur)) +
        (a == null ? '' : v[2] !== c.p[pr.cmp][2] ? ' · sumber beda, tidak dibandingkan' : (v[1] && c.p[pr.cmp][1] ? ' · <span class="' + tone(v[0] - a) + '">' + poinText(v[0] - a) + '</span> vs ' + esc(shortMonth(pr.cmp)) : ' · tidak dibandingkan')) +
        (v[1] ? '' : ' · belum terverifikasi'));
    }
    // Angka laporan emiten: laporan terakhir sampai Sampai, selisih dengan laporan pembanding (lihat reportPair).
    function reportTile(key, label, list, fmt, fmtDelta){
      var pr = reportPair(list, from, to);
      if (pr.cur == null) return tile(key, label, '—', 'laporan emiten sampai ' + esc(monthName(to)) + ' belum terbaca');
      var a = pr.cmp == null ? null : list[pr.cmp][0], b = list[pr.cur][0];
      return tile(key, label, fmt(b), 'laporan ' + esc(monthName(pr.cur)) +
        (a == null ? '' : (list[pr.cur][1] && list[pr.cmp][1] && (key !== 's4' || (a > 0 && b > 0)) ? ' · <span class="' + tone(b - a) + '">' + fmtDelta(b - a) + '</span> vs ' + esc(shortMonth(pr.cmp)) : ' · tidak dibandingkan')) +
        (list[pr.cur][1] ? '' : ' · belum terverifikasi'));
    }
    var ffAtTo = latestAt(c.f, to), ff = c.f[ffAtTo] || null, rs = c.r.charAt(to);
    var pills = '<span class="own-pill' + (tpOk(c, to) ? ' ok">KSEI ✓ per ' + esc(monthText(to)) : '">KSEI ◐ ' + esc(monthText(to)) + ' · lihat catatan') + '</span>' +
      '<span class="own-pill' + (rs === 'v' ? ' ok">Laporan emiten ✓ ' + esc(monthName(to)) : rs === 'x' ? '">Laporan emiten ◐ ' + esc(monthName(to)) + ' belum terbaca' :
        '">Laporan emiten ○ ' + esc(monthName(to)) + ' belum ada') + '</span>';

    var h = '<div class="own-head"><div><a class="own-back" href="' + ownHref('', from, to) + '">← Semua emiten</a>' +
      '<h2><span class="ticker">' + esc(c.t) + '</span>' + esc(c.n) + '</h2></div><div class="own-pills">' + pills + '</div></div>' +
      '<div class="own-tiles">' +
      tile('s1', 'Akumulasi &gt;1%', pctText(tpAt(c, to)), delta(tpAt(c, from), tpAt(c, to), poinText)) + b5Tile() +
      tile('s2', 'Sisa &lt;1% (perkiraan)', pctText(restAt(c, to)), delta(restAt(c, from), restAt(c, to), poinText)) +
      reportTile('s3', 'Free float resmi', c.f, pctText, poinText) +
      tile('', 'Pemegang &gt;1%', countText(holdersAt(c, to)), delta(holdersAt(c, from), holdersAt(c, to), countDelta)) +
      reportTile('s4', 'Jumlah pemegang saham', c.c, countText, countDelta) + '</div>' +
      '<p class="own-note">Akumulasi &gt;1%: total porsi pemegang &gt;1% (KSEI). Sisa &lt;1% = 100 − akumulasi. ' +
      'Pemegang ≥5%: dari laporan emiten; tanpa laporan, baris KSEI ≥5%; tanpa total saham, persen tertulis (belum terverifikasi). ' +
      'Free float resmi mengecualikan pengendali, afiliasi, direksi/komisaris, treasuri, jadi berbeda dari sisa &lt;1%.</p>';
    h += structHtml(c, from, to);

    var dom = chartDomain(c);
    function cell(v, ok, fmt){ return fmt(v) + (v != null && !ok ? ' <span class="own-tags">⚠ belum terverifikasi</span>' : ''); }
    h += '<section class="own-card"><div class="own-card-head"><h3>Tren bulanan</h3><span id="own-trend-note"></span></div>' +
      '<div class="own-presets" id="own-presets"></div><div class="own-chart" id="own-trend"></div><p class="own-legend"><span>○ = belum terverifikasi</span>' +
      '<span id="own-est-legend" hidden>putus-putus = ≥5% dari persen tertulis</span>' +
      '<span>celah = tanpa data (bukan nol) atau sumber ≥5% berganti</span></p>' +
      '<details class="own-twin"><summary>Lihat angka per bulan</summary><div class="own-scroll"><table class="own-table"><thead><tr>' +
      '<th scope="col">Bulan (tanggal KSEI)</th><th scope="col">Akumulasi &gt;1%</th><th scope="col">Pemegang ≥5%</th><th scope="col">Sisa &lt;1%</th><th scope="col">Free float resmi</th><th scope="col">Pemegang &gt;1%</th><th scope="col">Jumlah pemegang</th></tr></thead><tbody>' +
      (dom ? series(function(i){ return i; }, dom[0], dom[1]) : []).reverse().map(function(i){
        var p5 = c.p[i];
        return '<tr' + (i >= from && i <= to ? ' class="in-range"' : '') + '><th scope="row">' + esc(monthText(i)) + '</th><td>' + cell(tpAt(c, i), tpOk(c, i), pctText) +
          '</td><td>' + (p5 ? (p5[2] === 'P' ? pctText(r2(p5[0])) : cell(r2(p5[0]), p5[1], pctText)) + '<span class="own-tags">' + (p5[2] === 'K' ? 'KSEI' : p5[2] === 'P' ? 'persen tertulis' : 'laporan') + '</span>' : '—') +
          '</td><td>' + cell(restAt(c, i), tpOk(c, i), pctText) + '</td><td>' + cell(ffAt(c, i), okAt(c.f, i), pctText) + '</td><td>' + countText(holdersAt(c, i)) +
          '</td><td>' + cell(countAt(c, i), okAt(c.c, i), countText) + '</td></tr>';
      }).join('') + '</tbody></table></div></details></section>';

    var rows = investors(c, from, to);
    h += '<section class="own-card"><div class="own-card-head"><h3>Siapa menambah, siapa mengurangi</h3><span>' + esc(monthText(from)) + ' → ' + esc(monthText(to)) + ' · lembar</span></div>';
    if (!comparable){
      h += '<p class="own-note own-unavailable">KSEI &gt;1% tidak dibandingkan. ' + kseiPairNote(c, from, to) + '.';
      // Snapshot KSEI valid pertama di dalam rentang, supaya pembaca bisa langsung membandingkan pemegang 1–5%.
      var k0 = null;
      for (var ki = from + 1; ki < to; ki++) if (tpOk(c, ki)){ k0 = ki; break; }
      if (k0 != null && tpOk(c, to)) h += ' <a href="' + esc(ownHref(c.t, k0, to)) + '">Bandingkan KSEI ' + esc(monthText(k0)) + ' → ' + esc(monthText(to)) + ' →</a>';
      h += '</p>';
      if (!same && own.reports) h += '<div id="own-moves-dps"><p class="own-note">Memuat laporan emiten…</p></div>';
    } else if (same){
      h += '<p class="own-note">Pilih Dari dan Sampai yang berbeda untuk melihat perubahan.</p>';
    } else {
      var moved = rows.filter(function(r){ return r.ds || r.d; }).sort(function(x, y){ return (y.ds || 0) - (x.ds || 0); });
      var max = Math.max.apply(null, moved.map(function(r){ return Math.abs(r.ds || 0); }).concat([1]));
      h += !moved.length ? '<p class="own-note">Tidak ada perubahan pada pemegang yang tercatat di kedua snapshot.</p>' :
        '<div class="own-bars">' + moved.map(function(r){
          var width = Math.min(50, Math.abs(r.ds || 0) / max * 50);
          var label = r.ds == null ? 'Lembar belum terbaca' : r.ds ? signed(r.ds, 0, 'lembar') : 'Lembar tetap';
          return '<div class="own-bar-row"><span class="own-bar-name" title="' + esc(r.cur.name) + '">' + esc(r.cur.name) + '</span>' +
            '<span class="own-bar-track" aria-hidden="true">' + (r.ds ? '<i class="' + tone(r.ds) + '" style="width:' + width.toFixed(2) + '%"></i>' : '') + '</span>' +
            '<span class="own-bar-val ' + tone(r.ds) + '">' + label + '<small>Porsi: ' + poinText(r.d) + '</small></span></div>';
        }).join('') + '</div>';
      var threshold = rows.filter(function(r){ return r.status; });
      if (threshold.length) h += '<p class="own-note">Masuk/keluar daftar >1% (selisih lembar tidak diketahui):</p><ul class="own-sources own-threshold">' + threshold.map(function(r){
        return '<li>' + esc(r.cur.name) + ': ' + (r.status === 'baru' ? 'baru tercatat >1%, akhir ' + pctText(r.b.pct) : 'tidak lagi tercatat >1%, awal ' + pctText(r.a.pct)) + '.</li>';
      }).join('') + '</ul>';
      if (rows.some(function(r){ return r.a && r.b && r.ds == null; })) h += '<p class="own-note">Sebagian lembar belum terbaca; perubahannya tidak dihitung.</p>';
    }
    if (comparable) h += '<p class="own-note">Perubahan neto dua snapshot KSEI, bukan transaksi. Porsi bisa beda arah dari lembar bila total saham berubah; stock split menambah lembar tanpa transaksi. Tidak tercatat bukan berarti nol.</p>';
    h += '</section>';

    var list = rows.slice().sort(function(x, y){ return (x.b ? 0 : 1) - (y.b ? 0 : 1) || (y.cur.pct || 0) - (x.cur.pct || 0); });
    h += '<section class="own-card"><div class="own-card-head"><h3>Pemegang saham di atas 1%</h3><span>per ' + esc(monthText(to)) + (same ? '' : ' · dibanding ' + esc(monthText(from))) + '</span></div>';
    if (!comparable) h += '<p class="own-note">Perubahan tidak dibandingkan (lihat catatan di atas).</p>';
    h += !list.length ? '<p class="own-note">Tidak ada data pemegang KSEI untuk tanggal ini.</p>' :
      '<div class="own-scroll"><table class="own-table"><thead><tr><th scope="col">Pemegang</th>' +
      (same ? '' : '<th scope="col">' + esc(monthText(from, true)) + '</th>') + '<th scope="col">' + esc(monthText(to, true)) + '</th>' +
      (same ? '' : '<th scope="col">Perubahan</th>') + '<th scope="col">Lembar saham</th>' + (same ? '' : '<th scope="col">Perubahan lembar</th><th scope="col">Tren</th>') +
      '</tr></thead><tbody>' + list.map(function(r){
        var cur = r.cur, notes = [cur.cls, ORIGIN[cur.lf] || cur.lf].filter(Boolean);
        if (r.a && r.b && r.a.name !== r.b.name) notes.push(monthText(from, true) + ' tertulis ' + r.a.name);
        if (cur.rows > 1) notes.push('gabungan ' + cur.rows + ' baris KSEI');
        var dl = r.ds;
        return '<tr' + (r.b || !comparable ? '' : ' class="gone"') + '><th scope="row">' + esc(cur.name) + '<span class="own-tags">' + esc(notes.join(' · ')) + '</span></th>' +
          (same ? '' : '<td>' + (r.a ? pctText(r.a.pct) : '—') + '</td>') +
          '<td>' + (r.b ? '<div class="own-share"><span class="own-meter" aria-hidden="true"><i style="width:' + Math.max(0, Math.min(100, r.b.pct || 0)) + '%"></i></span><strong>' + pctText(r.b.pct) + '</strong></div>' : '—') + '</td>' +
          (same ? '' : '<td class="' + (r.status ? '' : tone(r.d)) + '">' + (r.status === 'baru' ? 'baru tercatat >1%' : r.status === 'keluar' ? 'tidak lagi tercatat >1%' : poinText(r.d)) + '</td>') +
          '<td>' + (r.b && r.b.total != null ? num(r.b.total, 0) : '—') + '</td>' +
          (same ? '' : '<td class="' + tone(dl) + '">' + (dl == null ? '—' : dl ? signed(dl, 0) : 'tetap') + '</td>' +
            '<td>' + spark(series(function(i){ var g = tpOk(c, i) ? groupsAt(c, i) : null; return g && g[r.inv] ? g[r.inv].pct : null; }, from, to)) + '</td>') + '</tr>';
      }).join('') + '</tbody></table></div><p class="own-note">Ejaan nama diseragamkan; nama sama dijumlahkan, nama yang hanya mirip tidak digabung.</p>';
    h += '</section>';

    h += (own.reports ? '<div id="own-reports"><section class="own-card"><div class="own-card-head"><h3>Daftar pemegang saham (laporan emiten)</h3></div><p class="own-note">Memuat laporan emiten…</p></section></div>' : '') +
      (own.changes ? '<section class="own-card" id="own-changes"><div class="own-card-head"><h3>Laporan perubahan kepemilikan</h3></div><p class="own-note">Memuat laporan…</p></section>' : '') +
      '<div id="own-bae"></div>';

    var notes = [];
    (same ? [to] : [from, to]).forEach(function(i){
      var m = ownData.months[i], url = safeUrl(m.url);
      if (url) notes.push('<li>KSEI: <a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(m.desc || 'Pemegang Saham di Atas 1% per ' + monthText(i)) + '</a></li>');
    });
    if (ff) notes.push('<li>Free float resmi ' + esc(monthName(ffAtTo)) + ': ' + pctText(ff[0]) + (ff[1] ? '' : ' (belum terverifikasi)') +
      (ff[2].length ? ' · versi lain: ' + ff[2].map(pctText).join(', ') : '') + '<span id="own-ff-link" data-i="' + ffAtTo + '"></span></li>');
    (same ? [to] : [from, to]).forEach(function(i){
      kseiIssues(c, i).forEach(function(x){ notes.push('<li>Catatan KSEI ' + esc(monthText(i, true)) + ': ' + esc(x) + '</li>'); });
    });
    if (priceAt(c.t, to) && ownData.prices.src) notes.push('<li>Harga penutupan ' + esc(monthText(to, true)) + ': ' + esc(ownData.prices.src) + ', belum disesuaikan aksi korporasi.</li>');
    h += '<section class="own-card"><div class="own-card-head"><h3>Sumber dan catatan</h3></div><ul class="own-sources">' + notes.join('') +
      '<li>Data: IDX Signal Desk.</li></ul></section>';
    return h;
  }

  // Total saham laporan bulan i; laporan lama sering tanpa total, jadi pakai laporan terdekat yang menuliskannya.
  function reportTotal(list, i){
    for (var d = 0; d < list.length; d++){
      if (list[i - d] && list[i - d].s > 0) return {s: list[i - d].s, i: i - d};
      if (list[i + d] && list[i + d].s > 0) return {s: list[i + d].s, i: i + d};
    }
    return null;
  }
  // Lembar dan persen tertulis cocok dengan total saham, sampai ketelitian desimal persen yang tertulis (minimal 2 desimal).
  function pctFits(r, total){
    if (!(total > 0) || r[2] == null || r[3] == null) return false;
    var t = String(r[3]), dot = t.indexOf('.'), dec = dot < 0 ? 0 : t.length - dot - 1;
    // Tepat di tengah (9,375 tertulis 9,37) ditolak, seperti pemeriksaan pembulatan Signal Desk.
    return Math.abs(r[2] / total * 100 - r[3]) < 0.5 * Math.pow(10, -Math.max(2, dec)) - 1e-12;
  }
  // Di bawah 0,1% toleransi pembulatan terlalu besar untuk menangkap salah baca lembar, jadi baris itu tidak diturunkan.
  function pctChecks(r, total){ return r[3] != null && r[3] >= 0.1 && pctFits(r, total); }
  // Seluruh baris ≥1% laporan itu cocok dengan total yang sama.
  function reportFits(rep, total){
    var big = rep.h.filter(function(r){ return r[2] != null && r[3] != null && r[3] >= 1; });
    return big.length > 0 && big.every(function(r){ return pctFits(r, total); });
  }
  // Pasangan baris DPS Dari–Sampai. Perubahan dihitung kalau kedua baris terverifikasi Signal Desk, atau (derived) kalau:
  // kedua laporan ditandai v (derivable() di tools/sync_idx.py: versi sepakat, sumber tidak diblokir, masalahnya hanya
  // peran/total saham tidak tertulis), kedua baris bertanda 1 (bukan agregat/nama berulang/baris bercatatan), total saham sama
  // di seluruh rentang, dan lembar/persen kedua baris serta semua baris ≥1% kedua laporan cocok dengan total itu.
  function dpsCompare(rep, from, to){
    var list = rep.d, readable = list.map(function(x){ return x && x.h.length ? x : null; });
    var pr = reportPair(readable, from, to), out = {list: list, pr: pr, newest: latestAt(list, to), cur: null, cmp: null, rows: [], totals: null};
    if (pr.cur == null) return out;
    var cur = out.cur = readable[pr.cur], cmp = out.cmp = pr.cmp == null ? null : readable[pr.cmp];
    var tc = reportTotal(list, pr.cur), tp = cmp ? reportTotal(list, pr.cmp) : null, same = false;
    if (tc && tp){
      // Total pinjaman tidak boleh melewati bulan yang total sahamnya berubah (stock split, rights issue).
      var lo = Math.min(pr.cmp, tp.i, tc.i), hi = Math.max(pr.cur, tp.i, tc.i), seen = [];
      for (var i = lo; i <= hi; i++) if (list[i] && list[i].s > 0 && seen.indexOf(list[i].s) === -1) seen.push(list[i].s);
      same = seen.length === 1;
      out.totals = {cur: tc.s, same: same, all: seen};
    }
    var fits = !!(cmp && same && cur.v && cmp.v && reportFits(cur, tc.s) && reportFits(cmp, tp.s));
    // Cocokkan baris antarlaporan per nama + peran; kalau peran berubah, per nama selama nama itu hanya sekali muncul.
    function index(rep){
      var byKey = Object.create(null), byName = Object.create(null);
      (rep ? rep.h : []).forEach(function(r){ var k = r[0] + '#' + r[1]; (byKey[k] = byKey[k] || []).push(r); (byName[r[0]] = byName[r[0]] || []).push(r); });
      return {key: byKey, name: byName};
    }
    var ic = index(cur), ip = index(cmp), used = [], rows = out.rows;
    cur.h.forEach(function(r){
      var k = r[0] + '#' + r[1], exact = ip.key[k], ambiguous = ic.key[k].length > 1 || (exact && exact.length > 1);
      var old = !ambiguous && exact && exact.length === 1 ? exact[0] : (!ambiguous && ip.name[r[0]] && ip.name[r[0]].length === 1 && ic.name[r[0]].length === 1 ? ip.name[r[0]][0] : null);
      if (old) used.push(old);
      // Nama yang muncul lebih dari sekali di laporan lain tanpa pasangan unik: bukan pemegang baru.
      rows.push({r: r, old: old, ambiguous: ambiguous || (!old && !!ip.name[r[0]])});
    });
    if (cmp) cmp.h.forEach(function(r){ if (used.indexOf(r) === -1){ var k = r[0] + '#' + r[1]; rows.push({r: null, old: r, ambiguous: ip.key[k].length > 1 || (ic.key[k] && ic.key[k].length > 1) || !!ic.name[r[0]]}); } });
    rows.forEach(function(x){
      var pair = x.r && x.old && !x.ambiguous;
      x.valid = !!(pair && x.r[4] && x.old[4]);
      x.derived = !x.valid && !!(pair && fits && x.r[5] === 1 && x.old[5] === 1 && x.r[1] && x.old[1] && pctChecks(x.r, tc.s) && pctChecks(x.old, tp.s));
      var ok = x.valid || x.derived;
      x.dp = ok && x.r[3] != null && x.old[3] != null ? Math.round((x.r[3] - x.old[3]) * 1e4) / 1e4 : null;
      x.ds = ok && x.r[2] != null && x.old[2] != null ? x.r[2] - x.old[2] : null;
    });
    return out;
  }
  var DERIVED_NOTE = 'belum terverifikasi; cocok dengan total saham';

  // Pengganti "Siapa menambah" saat snapshot KSEI tidak tersedia: perubahan antar laporan bulanan emiten.
  function dpsMovesHtml(rep){
    var st = ownState, cp = dpsCompare(rep, st.from, st.to), pr = cp.pr;
    var h = '<p class="own-note"><b>Dari laporan bulanan emiten</b> (≥5%, pengendali, afiliasi, direksi, komisaris)' +
      (cp.cmp ? ': laporan ' + esc(monthName(pr.cmp)) + ' → ' + esc(monthName(pr.cur)) + '.' : '.') + '</p>';
    if (!cp.cur || !cp.cmp) return h + '<p class="own-note">Belum ada dua laporan terbaca di rentang ini.</p>';
    var names = reportsData.names;
    var moved = cp.rows.filter(function(x){ return x.ds; }).sort(function(a, b){ return b.ds - a.ds; });
    var max = Math.max.apply(null, moved.map(function(x){ return Math.abs(x.ds); }).concat([1]));
    h += !moved.length ? '<p class="own-note">Tidak ada perubahan lembar yang terhitung.</p>' :
      '<div class="own-bars">' + moved.map(function(x){
        var width = Math.min(50, Math.abs(x.ds) / max * 50), name = names[x.r[0]];
        return '<div class="own-bar-row"><span class="own-bar-name" title="' + esc(name) + '">' + esc(name) + '</span>' +
          '<span class="own-bar-track" aria-hidden="true"><i class="' + tone(x.ds) + '" style="width:' + width.toFixed(2) + '%"></i></span>' +
          '<span class="own-bar-val ' + tone(x.ds) + '">' + signed(x.ds, 0, 'lembar') + '<small>Porsi: ' + (x.dp == null ? '—' : x.dp ? signed(x.dp, 4, 'poin') : 'tetap') +
          (x.derived ? ' · belum terverifikasi' : '') + '</small></span></div>';
      }).join('') + '</div>';
    // Daftar masuk/keluar hanya dari dua laporan derivable (format 2); format lama tidak menandai baris agregat.
    var listed = cp.cur.v === 1 && cp.cmp.v === 1;
    function sig(i){
      return String(names[i] || '').toUpperCase().split(/[^A-Z0-9]+/).filter(function(t){ return t && !/^(PT|TBK|PERSERO|LTD|LIMITED|PTE|INC|CO|CORP|DRS|DRA|IR|DR|SE|SH)$/.test(t); }).sort();
    }
    function holder(r){ return r[5] !== 2 && r[5] !== undefined && r[1] && r[2] != null && r[2] > 0; }
    var onlyCur = cp.rows.filter(function(x){ return x.r && !x.old && !x.ambiguous && holder(x.r); });
    var onlyCmp = cp.rows.filter(function(x){ return !x.r && x.old && !x.ambiguous && holder(x.old); });
    // Ejaan berbeda: kata inti sama, atau lembar sama persis dan berbagi kata pertama (salah ketik, nama terpotong).
    function variant(a, b){
      var x = sig(a.r[0]), y = sig(b.old[0]);
      return x.join(' ') === y.join(' ') || (a.r[2] === b.old[2] && x.some(function(t){ return y.indexOf(t) !== -1 || y.some(function(u){ return u.length >= 4 && t.length >= 4 && (u.indexOf(t) === 0 || t.indexOf(u) === 0); }); }));
    }
    var spelled = [], added = [], gone = [];
    onlyCur.forEach(function(x){
      var b = onlyCmp.filter(function(y){ return !y.spelled && variant(x, y); });
      var a = b.length === 1 ? onlyCur.filter(function(z){ return variant(z, b[0]); }) : [];
      if (b.length === 1 && a.length === 1){ spelled.push(names[x.r[0]] + ' / ' + names[b[0].old[0]]); b[0].spelled = true; }
      else added.push(names[x.r[0]]);
    });
    onlyCmp.forEach(function(x){ if (!x.spelled) gone.push(names[x.old[0]]); });
    var sameV = cp.rows.filter(function(x){ return x.ds === 0 && x.valid; }).map(function(x){ return names[x.r[0]]; });
    var sameD = cp.rows.filter(function(x){ return x.ds === 0 && x.derived; }).map(function(x){ return names[x.r[0]]; });
    var open = !listed ? [] : cp.rows.filter(function(x){ var r = x.r || x.old; return r[5] !== 2 && r[1] && ((x.r && x.old && x.ds == null) || x.ambiguous); })
      .map(function(x){ return names[(x.r || x.old)[0]]; }).filter(function(n, i, a){ return a.indexOf(n) === i; });
    var items = [];
    if (sameV.length) items.push('Tetap: ' + sameV.map(esc).join(', ') + '.');
    if (sameD.length) items.push('Tetap (belum terverifikasi): ' + sameD.map(esc).join(', ') + '.');
    if (!listed) items.push('Daftar nama antarlaporan tidak dibandingkan: laporan tidak lolos pemeriksaan sumber.');
    if (listed && added.length) items.push('Baru tercantum di laporan ' + esc(monthName(pr.cur)) + ': ' + added.map(esc).join(', ') + '.');
    if (listed && gone.length) items.push('Tidak tercantum lagi di laporan ' + esc(monthName(pr.cur)) + ' (bukan nol): ' + gone.map(esc).join(', ') + '.');
    if (listed && spelled.length) items.push('Ejaan nama berbeda, tidak dihitung: ' + spelled.map(esc).join('; ') + '.');
    if (open.length) items.push('Belum dihitung (belum terverifikasi atau nama berulang): ' + open.map(esc).join(', ') + '.');
    if (items.length) h += '<ul class="own-sources own-threshold">' + items.map(function(t){ return '<li>' + t + '</li>'; }).join('') + '</ul>';
    var t = cp.totals;
    if (t && !t.same) h += '<p class="own-note">Total saham berubah di rentang ini (' + t.all.map(countText).join(' → ') + '), mis. stock split atau rights issue. Angka belum terverifikasi tidak dibandingkan.</p>';
    if (cp.rows.some(function(x){ return x.derived; })) h += '<p class="own-note">Belum terverifikasi: dihitung karena lembar dan persen cocok dengan total saham ' + countText(t.cur) + ' (tetap di rentang ini).</p>';
    return h + '<p class="own-note">Perubahan neto dua laporan, bukan transaksi (lihat Laporan perubahan kepemilikan). Pemegang 1–5% lain tidak tercantum.</p>';
  }

  // Daftar pemegang saham dari laporan bulanan emiten (pemegang >=5%, pengendali, afiliasi, direksi, komisaris).
  function dpsHtml(c, rep){
    var st = ownState, cp = dpsCompare(rep, st.from, st.to), list = cp.list, pr = cp.pr, newest = cp.newest;
    var h = '<section class="own-card"><div class="own-card-head"><h3>Daftar pemegang saham (laporan emiten)</h3>';
    if (pr.cur == null){
      return h + '</div><p class="own-note">' + (newest != null ?
        'Laporan ' + esc(monthName(newest)) + ' belum terbaca Signal Desk. ' + sourceLink(list[newest].u, 'Buka di IDX') + '.' :
        'Belum ada laporan emiten di Signal Desk sampai ' + esc(monthName(st.to)) + '.') + '</p></section>';
    }
    var cur = cp.cur, cmp = cp.cmp, hc = countChange(c, st.from, st.to);
    h += '<span>laporan ' + esc(monthName(pr.cur)) + (cmp ? ' · dibanding ' + esc(monthName(pr.cmp)) : '') + '</span></div>';
    var facts = [];
    if (hc.cur != null) facts.push('Jumlah pemegang saham: <b>' + countText(hc.cur) + '</b>' +
      (hc.d != null ? ' <span class="' + tone(hc.d) + '">(' + (hc.d ? signed(hc.d, 0) + ' · ' + signed(hc.pct, 1) + '%' : 'tetap') + ' vs ' + esc(shortMonth(hc.pair.cmp)) + ')</span>' : '') +
      (hc.pair.cur !== pr.cur ? ' <span class="own-tags">' + esc(monthName(hc.pair.cur)) + '</span>' : ''));
    if (cur.s != null) facts.push('Total saham: <b>' + countText(cur.s) + '</b>');
    if (safeUrl(cur.u)) facts.push(sourceLink(cur.u, 'laporan di IDX'));
    if (facts.length) h += '<p class="own-facts">' + facts.join('<span class="sep">·</span>') + '</p>';
    var rows = cp.rows;
    function pct4(v){ return v == null ? '—' : num(v, 4) + '%'; }
    h += '<div class="own-scroll"><table class="own-table"><thead><tr><th scope="col">Nama</th><th scope="col">Peran</th>' +
      (cmp ? '<th scope="col">' + esc(shortMonth(pr.cmp)) + '</th>' : '') + '<th scope="col">' + esc(shortMonth(pr.cur)) + '</th>' +
      (cmp ? '<th scope="col">Perubahan</th>' : '') + '<th scope="col">Lembar saham</th>' + (cmp ? '<th scope="col">Perubahan lembar</th>' : '') + '</tr></thead><tbody>' +
      rows.map(function(x){
        var r = x.r || x.old, dp = x.dp, ds = x.ds;
        var tags = [];
        if (x.r && x.old && x.r[1] !== x.old[1]) tags.push(shortMonth(pr.cmp) + ': ' + roleText(x.old[1]));
        if (x.derived) tags.push(DERIVED_NOTE);
        else if (!r[4] || (x.old && !x.old[4])) tags.push('perlu dicek');
        if (x.ambiguous) tags.push('nama dan peran berulang');
        if (cmp && !x.old && !x.ambiguous) tags.push('tidak tercantum di ' + monthName(pr.cmp));
        if (!x.r && !x.ambiguous) tags.push('tidak tercantum di ' + monthName(pr.cur));
        return '<tr' + (x.r ? '' : ' class="gone"') + '><th scope="row">' + esc(reportsData.names[r[0]]) + (tags.length ? '<span class="own-tags">' + esc(tags.join(' · ')) + '</span>' : '') + '</th>' +
          '<td class="own-role">' + esc(roleText(r[1])) + '</td>' +
          (cmp ? '<td>' + (x.old ? pct4(x.old[3]) : '—') + '</td>' : '') +
          '<td>' + (x.r ? '<strong>' + pct4(x.r[3]) + '</strong>' : '—') + '</td>' +
          (cmp ? '<td class="' + tone(dp) + '">' + (dp == null ? '—' : dp ? signed(dp, 4, 'poin') : 'tetap') + '</td>' : '') +
          '<td>' + (x.r && x.r[2] != null ? num(x.r[2], 0) : (x.old && x.old[2] != null ? '<span class="own-tags">' + num(x.old[2], 0) + '</span>' : '—')) + '</td>' +
          (cmp ? '<td class="' + tone(ds) + '">' + (ds == null ? '—' : ds ? signed(ds, 0) : 'tetap') + '</td>' : '') + '</tr>';
      }).join('') + '</tbody></table></div>';
    var note = 'Pemegang ≥5%, pengendali, afiliasi, direksi, dan komisaris menurut laporan emiten. Tidak tercantum bukan berarti nol.';
    if (newest != null && newest > pr.cur) note += ' Laporan ' + monthName(newest) + ' belum terbaca Signal Desk' + (safeUrl(list[newest].u) ? ' (' + sourceLink(list[newest].u, 'buka di IDX') + ')' : '') + '.';
    return h + '<p class="own-note">' + note + '</p></section>';
  }

  function fillReports(c){
    var st = ownState, key = c.t + '|' + st.from + '|' + st.to;
    function current(){ return ownState.t === c.t && c.t + '|' + ownState.from + '|' + ownState.to === key; }
    loadReports().then(function(){
      if (!current()) return;
      var rep = reportsFor(c.t), el = document.getElementById('own-reports'), bae = document.getElementById('own-bae'), ffl = document.getElementById('own-ff-link');
      var mv = document.getElementById('own-moves-dps');
      if (el) el.innerHTML = dpsHtml(c, rep);
      if (mv) mv.innerHTML = dpsMovesHtml(rep);
      if (bae) bae.innerHTML = baeHtml(c, rep);
      if (ffl && safeUrl(rep.u[+ffl.getAttribute('data-i')])) ffl.innerHTML = ' · ' + sourceLink(rep.u[+ffl.getAttribute('data-i')], 'laporan emiten di IDX');
    }, function(){
      var el = current() && document.getElementById('own-reports'), mv = current() && document.getElementById('own-moves-dps');
      if (mv) mv.innerHTML = '<p class="own-note">Laporan emiten belum berhasil dimuat.</p>';
      if (el) el.innerHTML ='<section class="own-card"><div class="own-card-head"><h3>Daftar pemegang saham (laporan emiten)</h3></div><p class="own-note">Laporan emiten belum berhasil dimuat. Buka ulang emiten ini.</p></section>';
    });
  }

  function fillChanges(c){
    var st = ownState, key = c.t + '|' + st.from + '|' + st.to;
    function put(html){
      var el = document.getElementById('own-changes');
      if (el && ownState.t === c.t && c.t + '|' + ownState.from + '|' + ownState.to === key) el.innerHTML = html;
    }
    loadChanges().then(function(d){ put(changesHtml(c, d)); }, function(){
      put('<div class="own-card-head"><h3>Laporan perubahan kepemilikan</h3></div><p class="own-note">Laporan perubahan belum berhasil dimuat. Buka ulang emiten ini.</p>');
    });
  }

  // Laporan perubahan: setelah snapshot Dari sampai snapshot Sampai (inklusif di ujung akhir).
  // Bulan tanpa tanggal KSEI memakai awal/akhir bulan; bulan terakhir tetap punya batas akhir.
  function changesHtml(c, d){
    var st = ownState, rows = (d.companies[c.t] || []).slice().reverse(), cov = d.coverage;
    var fm = own.months[st.from], tm = own.months[st.to], lo = fm.asOf || fm.p + '-01';
    var hi = tm.asOf || tm.p + '-' + new Date(Date.UTC(+tm.p.slice(0, 4), +tm.p.slice(5, 7), 0)).getUTCDate();
    function dayText(v){ return v ? +v.slice(8, 10) + ' ' + BULAN[+v.slice(5, 7) - 1].slice(0, 3) + ' ' + v.slice(0, 4) : '—'; }
    function pos(sh, pct){ return (sh == null ? '—' : num(sh, 0)) + '<span class="own-tags">' + (pct == null ? '' : num(pct, 4) + '%') + '</span>'; }
    function table(list){
      return '<div class="own-scroll"><table class="own-table"><thead><tr><th scope="col" class="own-date">Tanggal</th><th scope="col" class="own-holder">Pemegang</th><th scope="col">Sebelum</th>' +
        '<th scope="col">Sesudah</th><th scope="col">Perubahan</th><th scope="col" class="own-tx">Transaksi</th><th scope="col">Sumber</th></tr></thead><tbody>' +
        list.map(function(r){
          var ds = r[3] != null && r[4] != null ? r[4] - r[3] : null, dp = r[5] != null && r[6] != null ? r[6] - r[5] : null;
          var tags = r[2] ? [r[2]] : [];
          var tx = r[7].slice(0, 12).map(function(x){
            return esc(x[0] || 'Transaksi') + (x[2] != null ? ' ' + num(x[2], 0) : '') + (x[3] != null ? ' @ Rp' + num(x[3], 2) : '') + (x[4] && x[4] !== r[0] ? ' · ' + dayText(x[4]) : '');
          });
          if (r[7].length > 12) tx.push('<span class="own-tags">+' + num(r[7].length - 12, 0) + ' transaksi lain di PDF</span>');
          return '<tr><td class="own-date">' + dayText(r[0]) + '</td>' +
            '<th scope="row" class="own-holder">' + esc(r[1] || '—') + (tags.length ? '<span class="own-tags">' + esc(tags.join(' · ')) + '</span>' : '') +
            (r[9].length ? '<span class="own-flag' + (r[8] ? ' note' : '') + '">' + (r[8] ? 'Catatan: ' : 'Perlu dicek: ') + esc(r[9].join('; ')) + '</span>' : '') + '</th>' +
            '<td>' + pos(r[3], r[5]) + '</td><td><strong>' + pos(r[4], r[6]) + '</strong></td>' +
            '<td class="' + tone(ds) + '">' + (ds == null ? '—' : ds ? signed(ds, 0) : 'tetap') + (dp == null || !r2(dp) ? '' : '<span class="own-tags">' + signed(dp, 4, 'poin') + '</span>') + '</td>' +
            '<td class="own-tx">' + (tx.length ? tx.join('<br>') : '—') + '</td>' +
            '<td>' + (sourceLink(r[10], 'PDF') || '—') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    var inside = rows.filter(function(r){ return r[0] && (fm.asOf ? r[0] > lo : r[0] >= lo) && r[0] <= hi; }), other = rows.filter(function(r){ return inside.indexOf(r) === -1; });
    var h = '<div class="own-card-head"><h3>Laporan perubahan kepemilikan</h3><span>' + inside.length + ' laporan di rentang' + (rows.length > inside.length ? ' · ' + rows.length + ' total' : '') + '</span></div>';
    if (!rows.length) h += '<p class="own-note">Belum ada laporan perubahan kepemilikan di Signal Desk.</p>';
    else {
      h += inside.length ? table(inside) : '<p class="own-note">Tidak ada laporan di rentang ' + esc(monthText(st.from)) + ' → ' + esc(monthText(st.to)) + '.</p>';
      if (other.length) h += '<details class="own-twin"><summary>Di luar rentang (' + other.length + ')</summary>' + table(other) + '</details>';
    }
    var note = 'Formulir KSEI/IDX dan surat BAE ≥5%, dibaca otomatis dari PDF; angka apa adanya. "Perlu dicek" = angka tidak saling cocok. ' +
      'Tanggal = transaksi terakhir; satu formulir bisa memuat transaksi lain di luar rentang. Data: ' + (fm.asOf ? 'setelah ' : 'mulai ') + dayText(lo) + ' sampai ' + dayText(hi) + '.';
    if (cov && cov.listed){
      note += ' Cakupan: ' + (cov.from ? esc(cov.from) + ' sampai ' + esc(cov.to || '') + ', ' : '') + num(cov.downloaded, 0) + '/' + num(cov.listed, 0) + ' PDF diunduh' +
        (cov.downloaded < cov.listed ? ' (belum lengkap).' : '.');
    }
    return h + '<p class="own-note">' + note + '</p>';
  }

  // Jenis pemilik dari laporan BAE (hanya sebagian emiten punya tabel ini yang terbaca).
  function baeHtml(c, rep){
    var st = ownState, list = rep.b, pr = reportPair(list, st.from, st.to);
    if (pr.cur == null) return '';
    var cur = list[pr.cur], cmp = pr.cmp == null ? null : list[pr.cmp], DOM = {L: 'Lokal', F: 'Asing', A: 'Semua'};
    var old = {};
    if (cmp){ cmp.r.forEach(function(r){ old['r' + r[0] + r[1]] = r; }); cmp.t.forEach(function(r){ old['t' + r[0]] = r; }); }
    function row(label, dom, r, prev, total){
      var d = prev && r[0] != null && prev[0] != null ? r[0] - prev[0] : null;
      return '<tr' + (total ? ' class="in-range"' : '') + '><th scope="row">' + esc(label) + '<span class="own-tags">' + esc(DOM[dom] || dom) + '</span></th>' +
        (cmp ? '<td>' + (prev ? countText(prev[0]) : '—') + '</td>' : '') + '<td><strong>' + countText(r[0]) + '</strong></td>' +
        (cmp ? '<td class="' + tone(d) + '">' + (d == null ? '—' : d ? signed(d, 0) : 'tetap') + '</td>' : '') +
        '<td>' + countText(r[1]) + '</td><td>' + (r[2] == null ? '—' : num(r[2], 5) + '%') + '</td></tr>';
    }
    return '<section class="own-card"><div class="own-card-head"><h3>Jenis pemilik (laporan BAE)</h3><span>laporan ' + esc(monthName(pr.cur)) + (cmp ? ' · dibanding ' + esc(monthName(pr.cmp)) : '') + '</span></div>' +
      '<div class="own-scroll"><table class="own-table"><thead><tr><th scope="col">Jenis pemilik</th>' + (cmp ? '<th scope="col">Pemegang ' + esc(shortMonth(pr.cmp)) + '</th>' : '') +
      '<th scope="col">Pemegang ' + esc(shortMonth(pr.cur)) + '</th>' + (cmp ? '<th scope="col">Perubahan</th>' : '') + '<th scope="col">Lembar saham</th><th scope="col">Porsi</th></tr></thead><tbody>' +
      cur.r.map(function(r){ return row(reportsData.categories[r[1]], r[0], r.slice(2), old['r' + r[0] + r[1]] && old['r' + r[0] + r[1]].slice(2)); }).join('') +
      cur.t.map(function(r){ return row({L: 'Total lokal', F: 'Total asing', A: 'Total'}[r[0]] || 'Total', r[0], r.slice(1), old['t' + r[0]] && old['t' + r[0]].slice(1), true); }).join('') +
      '</tbody></table></div><p class="own-note">Angka apa adanya dari laporan BAE. Jumlah pemegang menurut registrasi BAE, bukan investor unik. ' +
      sourceLink(cur.u, 'Buka di IDX') + '</p></section>';
  }

  function niceTicks(lo, hi){
    if (hi - lo < 1e-9){ lo -= 1; hi += 1; }
    var raw = (hi - lo) / 3, mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), step = 10 * mag;
    [1, 2, 2.5, 5, 10].some(function(s){ if (s * mag >= raw){ step = s * mag; return true; } return false; });
    var ticks = [], top = Math.ceil(hi / step - 1e-9) * step;
    for (var v = Math.floor(lo / step + 1e-9) * step; v <= top + step * 1e-6 && ticks.length < 9; v += step) ticks.push(Math.round(v / step) * step);
    return ticks;
  }

  // Bulan pertama dan terakhir yang punya angka untuk emiten ini; grafik dan tabel bulanan dipangkas ke sini.
  function chartDomain(c){
    var a = -1, b = -1;
    for (var i = 0; i < own.months.length; i++){
      if (tpAt(c, i) != null || b5At(c, i) != null || ffAt(c, i) != null || countAt(c, i) != null){ if (a < 0) a = i; b = i; }
    }
    return a < 0 ? null : [a, b];
  }

  function trendChart(el, c){
    var st = ownState, ms = own.months, n = ms.length, W = Math.max(300, Math.floor(el.clientWidth || 720)), narrow = W < 560;
    var known = chartDomain(c), dom = known || [0, n - 1], a = dom[0], b = dom[1];
    // Bawaan: semua bulan tampil supaya rentang mudah diseret. Tombol "Perbesar ke rentang" menampilkan Dari–Sampai plus satu bulan
    // di tiap sisi; tombol hanya muncul kalau ada bulan yang bisa disembunyikan.
    var za = Math.max(a, st.from - 1), zb = Math.min(b, st.to + 1), before = za > a, after = zb < b;
    var canZoom = !!known && za < zb && (before || after), zoom = canZoom && !st.chartAll;
    if (zoom){ a = za; b = zb; }
    var m = b - a + 1, note = document.getElementById('own-trend-note');
    // Rentang cepat dari Sampai ke belakang; "Sejak KSEI" dan "Semua" memakai bulan yang punya data.
    var presets = document.getElementById('own-presets'), lo = known ? known[0] : 0, hi = known ? known[1] : n - 1;
    if (presets){
      var opts = [[1, '1 bln'], [3, '3 bln'], [6, '6 bln'], [12, '1 thn']].filter(function(o){ return st.to - o[0] >= lo; })
        .map(function(o){ return [st.to - o[0], st.to, o[1]]; });
      if (DEF_FROM > lo && DEF_FROM < st.to) opts.push([DEF_FROM, st.to, 'Sejak KSEI']);
      if (lo < hi) opts.push([lo, hi, 'Semua']);
      opts = opts.filter(function(o, i){ return !opts.slice(0, i).some(function(x){ return x[0] === o[0] && x[1] === o[1]; }); });
      presets.innerHTML = opts.map(function(o){
        return '<a href="' + esc(ownHref(st.t, o[0], o[1])) + '"' + (o[0] === st.from && o[1] === st.to ? ' aria-current="true"' : '') +
          ' title="' + esc(monthText(o[0]) + ' → ' + monthText(o[1])) + '">' + o[2] + '</a>';
      }).join('') + '<span class="own-pick-msg" aria-live="polite"></span>';
    }
    if (note) note.innerHTML = 'Seret di chart, atau klik bulan awal lalu bulan akhir' + (!canZoom ? '' :
      ' <button type="button" id="own-zoom" class="own-zoom">' + (!zoom ? 'Perbesar ke rentang' :
        before && after ? 'Tampilkan semua bulan (' + esc(monthText(dom[0])) + ' – ' + esc(monthText(dom[1])) + ')' :
        before ? 'Tampilkan sejak ' + esc(monthText(dom[0])) : 'Tampilkan sampai ' + esc(monthText(dom[1]))) + '</button>');
    function vals(fn){ return series(fn, 0, n - 1); }
    var panes = [
      {fmt: pctText, series: [{cls: 's1', label: 'Akumulasi >1% (KSEI)', v: vals(function(i){ return tpAt(c, i); }), ok: vals(function(i){ return tpOk(c, i); })},
                              {cls: 's5', label: 'Pemegang ≥5%', v: vals(function(i){ return b5At(c, i) == null ? null : r2(b5At(c, i)); }), ok: vals(function(i){ return okAt(c.p, i); }),
                               src: vals(function(i){ return c.p[i] && c.p[i][2]; }), est: vals(function(i){ return !!c.p[i] && c.p[i][2] === 'P'; })}]},
      {fmt: pctText, series: [{cls: 's2', label: 'Sisa <1% (perkiraan)', v: vals(function(i){ return restAt(c, i); }), ok: vals(function(i){ return tpOk(c, i); })},
                              {cls: 's3', label: 'Free float resmi', v: vals(function(i){ return ffAt(c, i); }), ok: vals(function(i){ return okAt(c.f, i); })}]}];
    var counts = vals(function(i){ return countAt(c, i); });
    if (counts.some(function(v){ return v != null; })) panes.push({fmt: countText, series: [{cls: 's4', label: 'Jumlah pemegang saham', v: counts, ok: vals(function(i){ return okAt(c.c, i); })}]});
    var padL = narrow ? 58 : 70, padR = narrow ? 12 : 24, paneH = narrow ? 100 : 120, gap = 16, axisH = 38, band = (W - padL - padR) / m;
    function X(i){ return padL + band * (i - a + 0.5); }
    function has(se, i){ return i >= a && i <= b && se.v[i] != null; }
    // Legenda turun ke baris berikutnya kalau tidak muat.
    panes.forEach(function(p){
      var x = 12, y = 14;
      p.series.forEach(function(se){
        var w = 26 + se.label.length * 7.2 + 18;
        if (x > 12 && x + w > W - padR){ x = 12; y += 20; }
        se.lx = x; se.ly = y; x += w;
      });
      p.legendH = y + 14;
    });
    var H = axisH, y0 = 0, s = '', shownEst = false;
    panes.forEach(function(p, pi){ H += p.legendH + paneH + (pi ? gap : 0); });
    var axY = H - axisH, r0 = Math.max(st.from, a), r1 = Math.min(st.to, b);
    if (r0 <= r1) s += '<rect class="own-range" x="' + (X(r0) - band / 2).toFixed(1) + '" y="0" width="' + (band * (r1 - r0 + 1)).toFixed(1) + '" height="' + axY + '"/>';
    s += '<rect class="own-pickband" x="0" y="0" width="0" height="' + axY + '"/>';
    panes.forEach(function(p){
      p.series.forEach(function(se){
        s += '<line class="own-leg ' + se.cls + '" x1="' + se.lx + '" x2="' + (se.lx + 18) + '" y1="' + (y0 + se.ly - 4) + '" y2="' + (y0 + se.ly - 4) + '"/>' +
          '<text class="t" x="' + (se.lx + 26) + '" y="' + (y0 + se.ly) + '">' + esc(se.label) + '</text>';
      });
      var top = y0 + p.legendH, bottom = top + paneH, all = [], trusted = [];
      function usable(se, i){ return se.ok[i] || !!(se.est && se.est[i]); }  // perkiraan (P) ikut skala dan garis, tetapi putus-putus
      p.series.forEach(function(se){ for (var i = a; i <= b; i++) if (se.v[i] != null){ all.push(se.v[i]); if (usable(se, i)) trusted.push(se.v[i]); } });
      if (!all.length){
        s += '<text x="' + (padL + (W - padL - padR) / 2) + '" y="' + (top + paneH / 2) + '" text-anchor="middle">belum ada data</text>';
        y0 = bottom + gap; return;
      }
      // Skala dari angka terverifikasi kalau ada, supaya satu angka salah baca tidak meratakan garis; yang di luar skala menempel di tepi.
      var base = trusted.length ? trusted : all;
      var ticks = niceTicks(Math.min.apply(null, base), Math.max.apply(null, base)), lo = ticks[0], hi = ticks[ticks.length - 1];
      function Y(v){ return bottom - 4 - (Math.min(hi, Math.max(lo, v)) - lo) / ((hi - lo) || 1) * (paneH - 12); }
      ticks.forEach(function(t){
        var y = Y(t).toFixed(1);
        s += '<line class="own-grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y + '" y2="' + y + '"/>' +
          '<text x="' + (padL - 8) + '" y="' + (+y + 4) + '" text-anchor="end">' + esc(p.fmt(t)) + '</text>';
      });
      // Garis hanya menyambung dua bulan berurutan yang sama-sama terverifikasi; ruas yang menyentuh perkiraan (P) putus-putus.
      p.series.forEach(function(se){
        var d = '', dash = '';
        for (var i = a; i <= b; i++){
          if (!has(se, i) || !usable(se, i)) continue;
          var pt = X(i).toFixed(1) + ' ' + Y(se.v[i]).toFixed(1);
          var sameSource = !se.src || se.src[i] === se.src[i - 1];
          if (!se.est || !se.est[i]) d += (i > a && sameSource && has(se, i - 1) && se.ok[i - 1] && !(se.est && se.est[i - 1]) ? 'L' : 'M') + pt;
          if (i > a && sameSource && has(se, i - 1) && usable(se, i - 1) && se.est && (se.est[i] || se.est[i - 1]))
            dash += 'M' + X(i - 1).toFixed(1) + ' ' + Y(se.v[i - 1]).toFixed(1) + 'L' + pt;
        }
        if (d) s += '<path class="own-line ' + se.cls + '" d="' + d + '"/>';
        if (dash) s += '<path class="own-line est ' + se.cls + '" d="' + dash + '"/>';
        if (se.est) for (var e = a; e <= b; e++) if (se.est[e] && has(se, e)) shownEst = true;
      });
      var labels = {};  // label angka di awal/akhir rentang, dikumpulkan per bulan supaya dua seri tidak bertumpuk
      p.series.forEach(function(se){
        for (var i = a; i <= b; i++){
          if (!has(se, i)) continue;
          var v = se.v[i], edge = i === st.from || i === st.to, x = X(i), y = Y(v);
          s += '<circle class="own-dot ' + se.cls + (usable(se, i) ? '' : ' open') + '" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + (edge ? 4.5 : usable(se, i) ? 3 : 2.6) + '"/>';
          if (edge) (labels[i] = labels[i] || []).push({x: x, y: y, text: (se.est && se.est[i] ? '≈' : '') + p.fmt(v) + (usable(se, i) ? '' : ' ⚠') + (v > hi ? ' ↑' : v < lo ? ' ↓' : '')});
        }
      });
      // Label Sampai digambar dulu; label Dari yang akan menabraknya (rentang sempit, layar HP) digeser ke kiri titik atau dilewati.
      var placed = [], tight = st.from !== st.to && X(st.to) - X(st.from) < 90;
      Object.keys(labels).map(Number).sort(function(x, y){ return (y === st.to) - (x === st.to); }).forEach(function(i){
        var anchor = i === a ? 'start' : (i === b ? 'end' : 'middle'), shift = anchor === 'start' ? -6 : anchor === 'end' ? 6 : 0, last = null;
        if (tight && i === st.from && i !== a){ anchor = 'end'; shift = -8; }
        // Titik tertinggi diberi label di atas; titik di bawahnya yang labelnya akan menabrak diberi label di bawah titik.
        labels[i].sort(function(p1, p2){ return p1.y - p2.y; }).forEach(function(l){
          var ly = l.y - 10 < top + 4 ? l.y + 19 : l.y - 10;
          if (last != null && ly - last < 15) ly = l.y + 19;
          if (last != null && ly - last < 15) return;
          var w = l.text.length * 7.4, x = l.x + shift, x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
          if (placed.some(function(q){ return Math.abs(q.y - ly) < 15 && x0 < q.x1 + 4 && x0 + w > q.x0 - 4; })) return;
          placed.push({x0: x0, x1: x0 + w, y: ly});
          last = ly;
          s += '<text class="v" x="' + x.toFixed(1) + '" y="' + ly.toFixed(1) + '" text-anchor="' + anchor + '">' + esc(l.text) + '</text>';
        });
      });
      y0 = bottom + gap;
    });
    s += '<line class="own-axis" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + axY + '" y2="' + axY + '"/>';
    // Label bulan dijarangkan kalau tidak muat; bulan Dari dan Sampai selalu tertulis.
    var step = Math.max(1, Math.ceil((narrow ? 30 : 36) / band)), picked = [st.from, st.to].filter(function(i){ return i >= a && i <= b; });
    for (var i = a; i <= b; i++){
      var sel = picked.indexOf(i) !== -1;
      if (!sel && ((i - a) % step || picked.some(function(j){ return Math.abs(j - i) < step; }))) continue;
      var label = narrow || m > 12 ? BULAN[+ms[i].p.slice(5, 7) - 1].slice(0, 3) : monthText(i, true).replace(/ \d{4}$/, '');
      s += '<text class="' + (sel ? 'sel' : '') + '" x="' + X(i).toFixed(1) + '" y="' + (axY + 16) + '" text-anchor="middle">' + esc(label) + '</text>';
    }
    // Tahun di bawah bulan pertamanya; tahun awal yang terpotong tidak ditulis kalau terlalu dekat dengan tahun berikutnya.
    for (var j = a; j <= b; j++){
      if (j !== a && ms[j].p.slice(5, 7) !== '01') continue;
      if (j === a && ms[j].p.slice(5, 7) !== '01' && b > a){
        var nextJan = j + 13 - +ms[j].p.slice(5, 7);
        if (nextJan <= b && (nextJan - j) * band < 40) continue;
      }
      s += '<text x="' + X(j).toFixed(1) + '" y="' + (axY + 31) + '" text-anchor="middle">' + esc(ms[j].p.slice(0, 4)) + '</text>';
    }
    function tipLines(i){
      return panes.map(function(p){ return p.series.map(function(se){
        var v = se.v[i], est = !!(se.est && se.est[i]), note = v == null ? '' : (se.ok[i] || est ? '' : ' ⚠ belum terverifikasi') +
          (se.cls === 's5' && c.p[i] ? (c.p[i][2] === 'K' ? ' (KSEI)' : est ? ' (persen tertulis laporan, belum terverifikasi)' : ' (laporan)') : '');
        return [se, p.fmt(v) + note];
      }); }).reduce(function(x, y){ return x.concat(y); }, []);
    }
    var focusAt = st.to >= a && st.to <= b ? st.to : b;
    for (var k = a; k <= b; k++){
      s += '<rect class="own-hit" data-i="' + k + '" x="' + (X(k) - band / 2).toFixed(1) + '" y="0" width="' + band.toFixed(1) + '" height="' + axY + '" tabindex="' + (k === focusAt ? 0 : -1) + '" role="button" aria-label="' +
        esc(monthText(k) + ': ' + tipLines(k).map(function(l){ return l[0].label + ' ' + l[1]; }).join(', ')) + '"/>';
    }
    var estLegend = document.getElementById('own-est-legend');
    if (estLegend) estLegend.hidden = !shownEst;  // hanya kalau ada titik perkiraan di jendela yang tampil
    el.setAttribute('data-w', W);
    el.innerHTML = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="group" aria-label="Grafik bulanan ' + esc(c.t) +
      '. Panah kiri/kanan: pindah bulan. Enter: pilih bulan awal, lalu bulan akhir. Esc: batal.">' + s + '</svg><div class="own-tip" hidden></div>';

    var svg = el.querySelector('svg'), tip = el.querySelector('.own-tip');
    function showTip(rect){
      var i = +rect.getAttribute('data-i');
      tip.innerHTML = '<strong>' + esc(monthText(i)) + '</strong>' + tipLines(i).map(function(l){
        return '<span><i class="own-key ' + l[0].cls + '"></i>' + esc(l[0].label) + ': ' + esc(l[1]) + '</span>';
      }).join('') + '<em>' + (anchor != null ? 'klik: ' + esc(monthText(Math.min(anchor, i), true) + ' → ' + monthText(Math.max(anchor, i), true)) :
        'klik: mulai dari bulan ini · seret: pilih rentang') + '</em>';
      tip.hidden = false;
      var left = X(i) + band / 2 + 6;
      if (left + tip.offsetWidth > el.clientWidth) left = X(i) - band / 2 - 6 - tip.offsetWidth;
      tip.style.left = Math.max(4, left) + 'px';
    }
    // Pilih rentang: seret dari bulan awal ke bulan akhir, atau klik/Enter bulan awal lalu bulan akhir (Esc batal).
    var anchor = null, drag = null, pickRect = svg.querySelector('.own-pickband'), msg = presets && presets.querySelector('.own-pick-msg');
    function preview(f, t){
      if (f == null){ pickRect.classList.remove('on'); return; }
      pickRect.setAttribute('x', (X(f) - band / 2).toFixed(1)); pickRect.setAttribute('width', (band * (t - f + 1)).toFixed(1)); pickRect.classList.add('on');
    }
    function say(text){ if (msg) msg.textContent = text; }
    function apply(f, t){
      anchor = null; preview(null); say('');
      if (f !== st.from || t !== st.to) location.hash = ownHref(st.t, f, t);
    }
    function press(i){
      if (anchor == null){ anchor = i; preview(i, i); say('Dari ' + monthText(i, true) + ' · pilih bulan akhir (Esc batal)'); return false; }
      apply(Math.min(anchor, i), Math.max(anchor, i));
      return true;
    }
    function monthAt(e){
      var box = svg.getBoundingClientRect(), x = (e.clientX - box.left) * W / (box.width || W);
      return Math.max(a, Math.min(b, a + Math.floor((x - padL) / band)));
    }
    svg.addEventListener('pointerdown', function(e){
      var r = e.target.closest('.own-hit');
      if (!r || (e.pointerType === 'mouse' && e.button !== 0)) return;
      var i = +r.getAttribute('data-i');
      drag = {i0: i, i1: i, id: e.pointerId};
      try { svg.setPointerCapture(e.pointerId); } catch (err) {}
    });
    svg.addEventListener('pointermove', function(e){
      if (drag && e.pointerId === drag.id){
        var i = monthAt(e);
        if (i !== drag.i1){ drag.i1 = i; drag.moved = true; }
        if (drag.moved){ preview(Math.min(drag.i0, i), Math.max(drag.i0, i)); say(monthText(Math.min(drag.i0, i), true) + ' → ' + monthText(Math.max(drag.i0, i), true)); }
        var hit = svg.querySelector('.own-hit[data-i="' + i + '"]');
        if (hit) showTip(hit);
        return;
      }
      var r = e.target.closest('.own-hit'); if (r) showTip(r);
    });
    svg.addEventListener('pointerup', function(e){
      if (!drag || e.pointerId !== drag.id) return;
      var d = drag; drag = null;
      if (d.moved) apply(Math.min(d.i0, d.i1), Math.max(d.i0, d.i1)); else press(d.i0);
    });
    svg.addEventListener('pointercancel', function(){ drag = null; if (anchor != null) preview(anchor, anchor); else preview(null); });
    svg.addEventListener('pointerleave', function(){ if (!drag) tip.hidden = true; });
    svg.addEventListener('focusin', function(e){ if (e.target.classList.contains('own-hit')) showTip(e.target); });
    svg.addEventListener('focusout', function(){ tip.hidden = true; });
    svg.addEventListener('keydown', function(e){
      var r = e.target.closest('.own-hit');
      if (!r) return;
      var i = +r.getAttribute('data-i');
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight'){
        var next = svg.querySelector('.own-hit[data-i="' + (i + (e.key === 'ArrowLeft' ? -1 : 1)) + '"]');
        if (next){ r.setAttribute('tabindex', '-1'); next.setAttribute('tabindex', '0'); next.focus(); if (anchor != null) preview(Math.min(anchor, +next.getAttribute('data-i')), Math.max(anchor, +next.getAttribute('data-i'))); }
        e.preventDefault();
      } else if (e.key === 'Enter' || e.key === ' '){
        st.refocus = i; if (!press(i)) st.refocus = null; else showTip(r); e.preventDefault();
      } else if (e.key === 'Escape' && anchor != null){
        anchor = null; preview(null); say(''); showTip(r); e.preventDefault();
      }
    });
    if (st.refocus != null){
      var again = svg.querySelector('.own-hit[data-i="' + st.refocus + '"]');
      st.refocus = null;
      if (again){ svg.querySelectorAll('.own-hit').forEach(function(x){ x.setAttribute('tabindex', '-1'); }); again.setAttribute('tabindex', '0'); again.focus({preventScroll: true}); }
    }
  }

  if (own){
    var monthOptions = own.months.map(function(m, i){ return '<option value="' + i + '">' + esc(monthText(i)) + '</option>'; }).join('');
    ownFrom.innerHTML = monthOptions; ownTo.innerHTML = monthOptions;
    ownFrom.addEventListener('change', function(){ var f = +ownFrom.value; location.hash = ownHref(ownState.t, f, Math.max(f, ownState.to)); });
    ownTo.addEventListener('change', function(){ var t = +ownTo.value; location.hash = ownHref(ownState.t, Math.min(t, ownState.from), t); });
    ownPick.addEventListener('change', function(){ ownSearch.value = ''; location.hash = ownHref(ownPick.value, ownState.from, ownState.to); });
    var ownTimer;
    ownSearch.addEventListener('input', function(){
      clearTimeout(ownTimer);
      ownTimer = setTimeout(function(){
        ownState.all = false;
        // Mengetik saat membuka satu emiten kembali ke daftar yang tersaring.
        if (ownState.t) location.hash = ownHref('', ownState.from, ownState.to); else renderOwn();
      }, 140);
    });
    ownSearch.addEventListener('keydown', function(e){
      if (e.key !== 'Enter' || !ownData) return;
      var v = ownSearch.value.trim(), q = v.toLowerCase(), hit = ownData.byT[v.toUpperCase()];
      if (!hit){
        var matches = ownData.companies.filter(function(c){ return c.hay.indexOf(q) !== -1; });
        if (matches.length === 1) hit = matches[0];
      }
      if (hit){ ownSearch.value = ''; location.hash = ownHref(hit.t, ownState.from, ownState.to); }
    });
    ownBody.addEventListener('change', function(e){
      if (e.target.id !== 'own-urut') return;
      ownState.sort = e.target.value; ownState.all = false; renderOwn();
      var sel = document.getElementById('own-urut');
      if (sel) sel.focus();
    });
    ownBody.addEventListener('click', function(e){
      if (e.target.id === 'own-semua'){ ownState.all = true; renderOwn(); }
      if (e.target.id === 'own-zoom'){
        var el = document.getElementById('own-trend'), c = ownData && ownData.byT[ownState.t];
        ownState.chartAll = !ownState.chartAll;
        if (el && c){ trendChart(el, c); var again = document.getElementById('own-zoom'); if (again) again.focus(); }
      }
      if (e.target.id === 'own-retry') route();
    });
    var ownResize;
    window.addEventListener('resize', function(){
      clearTimeout(ownResize);
      ownResize = setTimeout(function(){
        var el = document.getElementById('own-trend'), c = ownData && ownData.byT[ownState.t];
        if (el && c && !ownView.hidden && +el.getAttribute('data-w') !== Math.max(300, Math.floor(el.clientWidth))) trendChart(el, c);
      }, 150);
    });
  }

  // ---- ringkasan Stockbit lintas hari ----------------------------------------
  // #emiten=KODE dan #pengguna=nama membaca files/stockbit-index/stockbit-index.json (tools/sync_idx.py --stockbit-only),
  // diambil sekali saat rute pertama dibuka. Nama berkas hari diubah ke path lewat daftar dokumen (byName), bukan ditulis tetap.
  // Semua string dari indeks masuk lewat textContent/atribut DOM, tidak pernah sebagai HTML.
  var sbMeta = data.stockbit, sbData = null, sbRoute = '';
  var SB_EP = {D: 'keterbukaan', A: 'hitungan', C: 'klaim', R: 'rumor', Q: 'pertanyaan', J: 'guyon'};
  var SB_NOTE = 'Klaim pengguna Stockbit, belum diverifikasi, bukan keterbukaan resmi.';
  var SB_JUDGEMENT = 'Penilaian otomatis atas argumen di posting, bukan atas orangnya';
  function hasKey(o, k){ return o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
  function sbEl(tag, attrs, kids){
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function(k){ if (attrs[k] != null) el.setAttribute(k, attrs[k]); });
    (kids == null ? [] : [].concat(kids)).forEach(function(c){ if (c != null) el.append(typeof c === 'object' ? c : String(c)); });
    return el;
  }
  function sbText(v, max){ return typeof v === 'string' ? v.slice(0, max || 600) : (typeof v === 'number' && Number.isFinite(v) ? String(v) : ''); }
  function sbNum(v){ return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0; }
  function sbDayText(iso){ return +iso.slice(8, 10) + ' ' + BULAN[+iso.slice(5, 7) - 1] + ' ' + iso.slice(0, 4); }
  function sbHref(v){
    v = String(v || '').trim().slice(0, 65);
    if (/^@/.test(v)) return '#pengguna=' + encodeURIComponent(v.replace(/^@+/, ''));
    if (/^[A-Za-z]{4}$/.test(v)) return '#emiten=' + v.toUpperCase();
    return '#pengguna=' + encodeURIComponent(v);
  }
  function sbDoc(name){ return typeof name === 'string' && hasKey(byName, name) ? byName[name] : null; }
  function validateSb(d){
    var k = checker('Struktur indeks Stockbit tidak valid.'), require = k.require, map = k.map;
    require(map(d) && d.format === 1 && Array.isArray(d.days) && d.days.length <= 20000 && map(d.tickers) && map(d.users));
    require(d.user_notes == null || map(d.user_notes));
    d.days.forEach(function(x){ require(map(x) && typeof x.d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.d)); });
  }
  var loadSb = jsonOnce(sbMeta && sbMeta.path, function(d){ validateSb(d); return (sbData = d); });
  // Baris [hariIdx, ...] yang hari-nya ada di indeks, terbaru dulu.
  function sbRows(d, list){
    if (!Array.isArray(list)) return [];
    return list.filter(function(r){ return Array.isArray(r) && Number.isSafeInteger(r[0]) && r[0] >= 0 && r[0] < d.days.length; })
      .sort(function(a, b){ return d.days[a[0]].d < d.days[b[0]].d ? 1 : d.days[a[0]].d > d.days[b[0]].d ? -1 : 0; });
  }
  function sbIds(v){ return Array.isArray(v) ? v.filter(function(x){ return typeof x === 'string' && x; }).slice(0, 500).map(function(x){ return x.slice(0, 80); }) : []; }
  function sbDayLink(day, section){
    var ring = sbDoc(day.f), label = sbDayText(day.d);
    return ring ? sbEl('a', {href: docRoute(ring.path, section)}, label) : sbEl('span', null, label);
  }
  function sbFindingLink(day, id){
    var doc = sbDoc(day.detail) || sbDoc(day.f);
    return doc ? sbEl('a', {href: docRoute(doc.path), title: sbDayText(day.d)}, id) : sbEl('span', null, id);
  }
  function sbHead(kicker, title, meta){
    var back = document.getElementById('stockbit-ringkasan') ? '#stockbit-ringkasan' : '#';
    return [
      sbEl('nav', {'class': 'crumbs', 'aria-label': 'Lokasi'}, [sbEl('a', {href: back}, '← Ringkasan Stockbit'), sbEl('span', null, '/'), sbEl('span', null, kicker)]),
      sbEl('header', {'class': 'doc-head'}, [
        sbEl('p', {'class': 'kicker'}, [sbEl('span', {'class': 'swatch'}), 'Ringkasan Stockbit', sbEl('span', null, '·'), kicker]),
        sbEl('h1', null, title),
        meta ? sbEl('p', {'class': 'meta'}, meta.map(function(m){ return sbEl('span', null, m); })) : null,
        sbEl('p', {'class': 'sb-note'}, SB_NOTE)
      ])
    ];
  }
  function sbTable(heads, rows){
    return sbEl('table', null, [
      sbEl('thead', null, sbEl('tr', null, heads.map(function(t){ return sbEl('th', {scope: 'col'}, t); }))),
      sbEl('tbody', null, rows)
    ]);
  }
  function sbEp(v){
    if (!v || typeof v !== 'object' || Array.isArray(v)) return '';
    return Object.keys(v).filter(function(k){ return sbNum(v[k]) > 0; }).slice(0, 12).map(function(k){
      return fmtNum(v[k]) + ' ' + (hasKey(SB_EP, k) ? SB_EP[k] : k.slice(0, 20));
    }).join(' · ');
  }
  // ---- "selengkapnya": teks lengkap sel indeks yang dipendekkan ----------------------------------------------
  // Desk memendekkan sel indeks di batas kalimat/klausa dan memberi tanda: BEI baris[9] === 1 ("Yang berubah"),
  // Stockbit baris[7] === 1 (inti; baris[6] = pk atau null). Indeks lama tanpa tanda: sel yang berakhir "…".
  // Klik mengambil dokumen detail hari itu (loadDoc, sekali per dokumen, tersimpan di memori), mencari bagian
  // "## KODE" / "## KODE — Nama" lalu baris teksnya: "Kesinambungan (…): …" (BEI), "… · inti (diskusi pengguna,
  // belum diverifikasi): …" (Stockbit). Teks masuk lewat textContent; kalau tidak ketemu/gagal: tautan ke detail.
  var INTI_MARK = ' · inti (diskusi pengguna, belum diverifikasi): ', emDetailCache = Object.create(null);
  function mdPlain(t){
    return String(t).replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, '$1').replace(/\*\*|__/g, '')
      .replace(/\\([\\`*_{}\[\]()#+\-.!<>|~])/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 4000);
  }
  // {KODE: {delta, inti, pk}} dari Markdown detail BEI/Stockbit; hanya baris pertama tiap jenis per bagian.
  function emitenDetailSections(md){
    var out = Object.create(null), cur = null;
    String(md || '').split(/\r?\n/).forEach(function(line){
      var h = /^##\s+([A-Z][A-Z0-9]{1,7})(?:\s+[—–-]\s+.*)?\s*$/.exec(line), m, i;
      if (h){ cur = hasKey(out, h[1]) ? null : (out[h[1]] = {}); return; }
      if (/^#{1,2}\s/.test(line)){ cur = null; return; }
      if (!cur) return;
      if (cur.delta == null && (m = /^Kesinambungan \([^)]{0,60}\):\s+(\S.*)$/.exec(line))) cur.delta = mdPlain(m[1]);
      else if (cur.inti == null && (i = line.indexOf(INTI_MARK)) !== -1) cur.inti = mdPlain(line.slice(i + INTI_MARK.length));
      else if (cur.pk == null && (m = /^Perkembangan:\s+(\S.*)$/.exec(line))) cur.pk = mdPlain(m[1]);
    });
    return out;
  }
  function emShortened(flag, text){ return flag === 1 || (flag == null && typeof text === 'string' && /…$/.test(text)); }
  // Sel tabel: teks indeks + tombol "selengkapnya" bila dipendekkan dan hari itu punya dokumen detail.
  function emCell(text, shortened, detail, code, field){
    var span = sbEl('span', null, text), td = sbEl('td', null, span);
    if (!shortened || !text) return td;
    var btn = sbEl('button', {type: 'button', 'class': 'sb-more'}, 'selengkapnya');
    function fallback(){
      btn.remove();
      var note = sbEl('span', {'class': 'sb-more-note'}, detail ? 'teks lengkap ada di halaman detail: ' : 'teks lengkap ada di halaman detail');
      if (detail) note.append(sbEl('a', {href: docRoute(detail.path, code.toLowerCase())}, 'buka detail'));
      td.append(note);
    }
    btn.addEventListener('click', function(){
      if (btn.disabled) return;
      if (!detail){ fallback(); return; }
      btn.disabled = true; btn.textContent = 'memuat…';
      loadDoc(detail).then(function(doc){
        var secs = emDetailCache[doc.path] || (emDetailCache[doc.path] = emitenDetailSections(doc.content));
        var full = hasKey(secs, code) ? secs[code][field] : null;
        if (typeof full !== 'string' || !full){ fallback(); return; }
        span.textContent = full; btn.remove(); td.setAttribute('data-full', '');
      }).catch(fallback);
    });
    td.append(' ', btn);
    return td;
  }
  // Bagian "Diskusi Stockbit" di halaman #emiten= (disclaimer Stockbit hanya di bagian ini).
  function sbEmitenSection(d, code){
    var rows = sbRows(d, hasKey(d.tickers, code) ? d.tickers[code] : null), posts = 0, found = 0;
    rows.forEach(function(r){ posts += sbNum(r[1]); found += sbNum(r[3]); });
    var body = emSection('stockbit-ringkasan', 'em-stockbit', 'Diskusi Stockbit', SB_NOTE,
      rows.length ? [fmtNum(rows.length) + ' hari', fmtNum(posts) + ' posting', fmtNum(found) + ' temuan'] : null);
    if (!rows.length){
      body.append(sbEl('p', {'class': 'doc-loading'}, code + ' belum muncul di ringkasan Stockbit yang terindeks.'));
    } else {
      body.append(sbTable(['Tanggal', 'Posting', 'Akun', 'Temuan', 'Inti (diskusi pengguna, belum diverifikasi)', 'Bahan'], rows.map(function(r){
        var day = d.days[r[0]], found = sbNum(r[3]), date = sbEl('td', {'class': 'd'}, sbDayLink(day, found ? code.toLowerCase() : 'disebut-tanpa-temuan'));
        var det = sbDoc(day.detail);
        if (day.k && day.k !== 'final') date.append(' · ' + sbText(day.k, 20));
        if (det && found) date.append(sbEl('br'), sbEl('a', {href: docRoute(det.path, code.toLowerCase())}, 'detail'));
        var inti = sbText(r[4] && typeof r[4] === 'object' ? r[4].text : r[4]);
        return sbEl('tr', null, [date, sbEl('td', {'class': 'n'}, fmtNum(sbNum(r[1]))), sbEl('td', {'class': 'n'}, fmtNum(sbNum(r[2]))),
          sbEl('td', {'class': 'n'}, fmtNum(found)), emCell(inti, found > 0 && emShortened(r[7], inti), det, code, 'inti'),
          sbEl('td', null, sbEp(r[5]))]);
      })));
    }
    return body;
  }
  function sbUserKey(d, handle){
    if (hasKey(d.users, handle)) return handle;
    var low = handle.toLowerCase(), hit = null;
    Object.keys(d.users).some(function(k){ if (k.toLowerCase() === low){ hit = k; return true; } return false; });
    return hit;
  }
  function sbPenggunaView(d, handle){
    var key = sbUserKey(d, handle), rows = sbRows(d, key ? d.users[key] : null), posts = 0, ids = 0, dayOf = Object.create(null);
    rows.forEach(function(r){ posts += sbNum(r[1]); sbIds(r[3]).forEach(function(id){ ids++; if (!dayOf[id]) dayOf[id] = d.days[r[0]]; }); });
    var name = '@' + (key || handle);
    var view = sbEl('div', {'class': 'sb-view'}, sbHead('Pengguna', name,
      [fmtNum(rows.length) + ' hari', fmtNum(posts) + ' posting', fmtNum(ids) + ' temuan']));
    var body = sbEl('div', {'class': 'sb-body'});
    var note = key && hasKey(d.user_notes, key) ? d.user_notes[key] : null;
    if (!note || typeof note !== 'object' || Array.isArray(note)) note = null;
    function noteText(v){ return v && typeof v === 'object' && !Array.isArray(v) && typeof v.text === 'string' && v.text.trim() ? v : null; }
    // Id temuan ditautkan ke berkas harinya kalau id itu ada di baris pengguna ini; selain itu teks biasa.
    function refLine(label, list){
      var line = sbEl('p', {'class': 'sb-refs'}, label);
      list.forEach(function(id, i){ if (i) line.append(', '); line.append(dayOf[id] ? sbFindingLink(dayOf[id], id) : id); });
      return line;
    }
    var pen = note ? noteText(note.penilaian) : null, benang = note ? noteText(note.benang) : null;
    if (pen || benang){
      var box = sbEl('section', {'class': 'sb-judgement', 'aria-label': SB_JUDGEMENT}, sbEl('h2', null, SB_JUDGEMENT));
      if (pen){
        var refs = sbIds(pen.finding_ids);
        box.append(sbEl('p', null, sbText(pen.text, 1200)));
        if (refs.length) box.append(refLine('Rujukan temuan: ', refs));
      }
      if (benang){
        // Benang lintas hari dari desk (<=220 huruf, 2-6 temuan dari >=2 hari); dipotong defensif kalau lebih.
        var threadRefs = sbIds(benang.finding_ids).slice(0, 12);
        box.append(sbEl('h3', null, 'Benang lintas hari'), sbEl('p', {'class': 'sb-thread'}, sbText(benang.text, 400)));
        if (threadRefs.length) box.append(refLine('Rujukan: ', threadRefs));
      }
      var based = note.based_on, basedDay = based && typeof based === 'object' && !Array.isArray(based) ? based.last_day : null;
      if (Number.isSafeInteger(basedDay != null ? based.findings : NaN) && based.findings >= 0 && typeof basedDay === 'string'
          && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(basedDay)){
        box.append(sbEl('p', {'class': 'sb-refs'}, 'Berdasarkan ' + fmtNum(based.findings) + ' temuan s.d. ' + sbDayText(basedDay)));
      } else {
        var win = note.window, winText = typeof win === 'string' ? win : (win && typeof win === 'object' && typeof win.start === 'string' && typeof win.end === 'string' ? win.start + ' – ' + win.end : '');
        if (winText) box.append(sbEl('p', {'class': 'sb-refs'}, 'Jendela: ' + winText.slice(0, 60)));
      }
      body.append(box);
    }
    if (!rows.length){
      body.append(sbEl('p', {'class': 'doc-loading'}, name + ' tidak ada di indeks ringkasan Stockbit. Indeks hanya memuat akun yang punya temuan publik.'));
    } else {
      body.append(sbTable(['Tanggal', 'Posting', 'Emiten', 'Temuan'], rows.map(function(r){
        var day = d.days[r[0]], codes = Array.isArray(r[2]) ? r[2].filter(function(t){ return typeof t === 'string' && t; }).slice(0, 60) : [];
        var ring = sbDoc(day.f), chips = sbEl('div', {'class': 'sb-chips'}, codes.map(function(t){
          t = t.slice(0, 12);
          return ring ? sbEl('a', {'class': 'chip', href: docRoute(ring.path, t.toLowerCase())}, t) : sbEl('span', {'class': 'chip'}, t);
        }));
        var found = sbEl('td', {'class': 'sb-refs'});
        sbIds(r[3]).forEach(function(id, i){ if (i) found.append(', '); found.append(sbFindingLink(day, id)); });
        var date = sbEl('td', {'class': 'd'}, sbDayLink(day));
        if (day.k && day.k !== 'final') date.append(' · ' + sbText(day.k, 20));
        return sbEl('tr', null, [date, sbEl('td', {'class': 'n'}, fmtNum(sbNum(r[1]))), sbEl('td', null, chips), found]);
      })));
    }
    view.append(body);
    return view;
  }
  function showStockbit(p){
    var kind = p.has('emiten') ? 'emiten' : 'pengguna', key = (p.get(kind) || '').trim().slice(0, 64);
    key = kind === 'emiten' ? key.toUpperCase() : key.replace(/^@+/, '');
    var routeKey = kind + '=' + key, fresh = routeKey !== sbRoute || reader.hidden || current;
    sbRoute = routeKey; current = null; renderedQuery = null;
    overview.hidden = true; reader.hidden = false;
    if (kind === 'emiten'){ showEmiten(key, routeKey, fresh); return; }
    reader.setAttribute('data-cat', 'stockbit-ringkasan');
    selectedCategory = 'stockbit-ringkasan'; markSource();
    document.title = (kind === 'emiten' ? key : '@' + key) + ' · Ringkasan Stockbit · ' + siteTitle;
    if (fresh) window.scrollTo(0, 0);
    function status(text, retry){
      reader.replaceChildren(sbEl('div', {'class': 'sb-view'}, sbHead(kind === 'emiten' ? 'Emiten' : 'Pengguna', kind === 'emiten' ? key : '@' + key)
        .concat(sbEl('div', {'class': 'doc-loading', role: 'status'}, [sbEl('p', null, text), retry ? sbEl('button', {type: 'button', 'class': 'sb-retry', 'data-sb-retry': ''}, 'Coba lagi') : null]))));
    }
    function paint(){
      if (sbRoute !== routeKey || reader.hidden || current) return;
      reader.replaceChildren(sbPenggunaView(sbData, key));
    }
    if (!key){ status('Tulis kode emiten atau @pengguna.'); return; }
    if (!sbMeta){ status('Indeks ringkasan Stockbit belum tersedia di arsip ini.'); return; }
    if (sbData){ paint(); return; }
    status('Memuat indeks ringkasan Stockbit…');
    loadSb().then(paint, function(){ if (sbRoute === routeKey && !reader.hidden && !current) status('Indeks ringkasan Stockbit gagal dimuat.', true); });
  }
  // ---- halaman emiten gabungan: keterbukaan resmi BEI + diskusi Stockbit -------------------------
  // #emiten=KODE membaca files/bei-index/bei-index.json (tools/sync_idx.py --bei-only) dan stockbit-index.json, masing-masing
  // diambil sekali. Bagian BEI di atas, Stockbit di bawah; label dan disclaimer terpisah. Kode yang hanya ada di salah satu
  // indeks tetap punya halaman, dan satu indeks yang gagal dimuat tidak menyembunyikan bagian lainnya.
  // Semua string dari indeks masuk lewat textContent/atribut DOM, tidak pernah sebagai HTML.
  var beiMeta = data.bei, beiData = null;
  var BEI_NOTE = 'Ringkasan otomatis dari pengumuman resmi di idx.co.id; bukan rekomendasi. Angka dikutip dari dokumen emiten dan belum diaudit ulang.';
  function validateBei(d){
    var k = checker('Struktur indeks BEI tidak valid.'), require = k.require, map = k.map;
    require(map(d) && d.format === 1 && Array.isArray(d.days) && d.days.length <= 20000 && map(d.tickers));
    require(d.names == null || map(d.names));
    d.days.forEach(function(x){ require(map(x) && typeof x.d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.d)); });
  }
  var loadBei = jsonOnce(beiMeta && beiMeta.path, function(d){ validateBei(d); return (beiData = d); });
  function emSection(cat, cls, title, note, meta){
    var sec = sbEl('section', {'class': 'em-sec ' + cls, 'data-cat': cat, 'aria-label': title}, [
      sbEl('h2', {'class': 'em-title'}, [sbEl('span', {'class': 'swatch'}), title]),
      meta ? sbEl('p', {'class': 'meta'}, meta.map(function(m){ return sbEl('span', null, m); })) : null,
      sbEl('p', {'class': 'sb-note'}, note)
    ]);
    return sec;
  }
  function beiCats(v){
    if (!v || typeof v !== 'object' || Array.isArray(v)) return '';
    return Object.keys(v).filter(function(k){ return sbNum(v[k]) > 0; }).slice(0, 12).map(function(k){
      return k.slice(0, 40) + ' ' + fmtNum(v[k]);
    }).join(' · ');
  }
  function beiDayText(day){ return /^\d{4}-\d{2}-\d{2}$/.test(day.d) ? sbDayText(day.d) : ''; }
  // Bagian ringkasan untuk emiten non-rutin, dari petunjuk desk di baris[8]: id bagian ('bbca', 'emiten-lain', ...),
  // true (punya blok ### KODE) / false (hanya satu baris di "Emiten lain"), atau objek {s|section|anchor}. Tanpa petunjuk: null.
  function beiAnchor(hint, code){
    if (hint && typeof hint === 'object' && !Array.isArray(hint))
      hint = hasKey(hint, 's') ? hint.s : hasKey(hint, 'section') ? hint.section : hasKey(hint, 'anchor') ? hint.anchor : null;
    if (hint === true) return code.toLowerCase();
    if (hint === false) return 'emiten-lain';
    return typeof hint === 'string' && /^[a-z0-9][a-z0-9-]{0,80}$/i.test(hint) ? hint.toLowerCase() : null;
  }
  // Bagian "Keterbukaan resmi BEI": Tanggal | Pengumuman | Status/Tahap | Yang berubah | Kategori, terbaru dulu.
  function beiEmitenSection(d, code){
    var rows = sbRows(d, hasKey(d.tickers, code) ? d.tickers[code] : null), anns = 0;
    rows.forEach(function(r){ anns += sbNum(r[1]); });
    var sec = emSection('bei-ringkasan', 'em-bei', 'Keterbukaan resmi BEI', BEI_NOTE,
      rows.length ? [fmtNum(rows.length) + ' hari', fmtNum(anns) + ' pengumuman'] : null);
    if (!rows.length){
      sec.append(sbEl('p', {'class': 'doc-loading'}, code + ' belum muncul di ringkasan keterbukaan BEI yang terindeks.'));
      return sec;
    }
    sec.append(sbTable(['Tanggal', 'Pengumuman', 'Status/Tahap', 'Yang berubah', 'Kategori'], rows.map(function(r){
      var day = d.days[r[0]], ring = sbDoc(day.f), det = sbDoc(day.detail), label = beiDayText(day);
      var n = sbNum(r[1]), nonroutine = sbNum(r[2]), lower = code.toLowerCase();
      // Emiten yang hari itu hanya punya laporan rutin muncul di bagian "Laporan rutin" ringkasan, bukan di bloknya sendiri.
      // Emiten non-rutin tanpa blok sendiri di ringkasan hanya satu baris di "Emiten lain"; tanpa petunjuk desk tanggalnya
      // menuju detail, yang selalu punya ## KODE, dan ringkasan jadi tautan kedua.
      var section = nonroutine ? beiAnchor(r[8], code) : 'laporan-rutin';
      var toDetail = !!(nonroutine && !section && det), main = toDetail ? det : ring;
      var date = sbEl('td', {'class': 'd'}, main ? sbEl('a', {href: docRoute(main.path, toDetail ? lower : section || lower)}, label)
        : sbEl('span', null, label));
      if (day.k && day.k !== 'final') date.append(' · ' + sbText(day.k, 20));
      if (toDetail && ring) date.append(sbEl('br'), sbEl('a', {href: docRoute(ring.path)}, 'ringkasan'));
      else if (det && nonroutine) date.append(sbEl('br'), sbEl('a', {href: docRoute(det.path, lower)}, 'detail'));
      var ids = sbIds(r[7]).slice(0, 40);
      var count = sbEl('td', {'class': 'n', title: ids.length ? 'Id pengumuman: ' + ids.join(', ') : null},
        fmtNum(n) + (nonroutine !== n ? ' · ' + fmtNum(nonroutine) + ' non-rutin' : ''));
      var stage = [sbText(r[3], 60), sbText(r[4], 80)].filter(function(t){ return t; }).join(' · ');
      var delta = sbText(r[5], 300);
      return sbEl('tr', null, [date, count, sbEl('td', null, stage),
        emCell(delta, nonroutine > 0 && emShortened(r[9], delta), det, code, 'delta'), sbEl('td', null, beiCats(r[6]))]);
    })));
    return sec;
  }
  function emName(code){
    var n = beiData && beiData.names && hasKey(beiData.names, code) ? beiData.names[code] : null;
    return typeof n === 'string' ? n.slice(0, 120) : '';
  }
  function emHead(code){
    var back = document.getElementById('bei-ringkasan') ? '#bei-ringkasan' : document.getElementById('stockbit-ringkasan') ? '#stockbit-ringkasan' : '#';
    var name = emName(code);
    return [
      sbEl('nav', {'class': 'crumbs', 'aria-label': 'Lokasi'}, [sbEl('a', {href: back}, '← Daftar'), sbEl('span', null, '/'), sbEl('span', null, 'Emiten')]),
      sbEl('header', {'class': 'doc-head'}, [
        sbEl('p', {'class': 'kicker'}, [sbEl('span', {'class': 'swatch'}), 'Emiten']),
        sbEl('h1', null, code),
        name ? sbEl('p', {'class': 'meta em-name'}, sbEl('span', null, name)) : null
      ])
    ];
  }
  function emFailed(cat, cls, title, note, what){
    var sec = emSection(cat, cls, title, note, null);
    sec.append(sbEl('div', {'class': 'doc-loading', role: 'status'}, [sbEl('p', null, what + ' gagal dimuat.'),
      sbEl('button', {type: 'button', 'class': 'sb-retry', 'data-sb-retry': ''}, 'Coba lagi')]));
    return sec;
  }
  function emitenView(code, bei, sb){
    var view = sbEl('div', {'class': 'sb-view em-view'}, emHead(code));
    var body = sbEl('div', {'class': 'sb-body'});
    if (own && own.tickers.indexOf(code) !== -1)
      body.append(sbEl('p', null, sbEl('a', {href: '#kepemilikan=' + encodeURIComponent(code)}, 'Kepemilikan saham ' + code + ' →')));
    if (beiMeta) body.append(bei ? beiEmitenSection(bei, code) : emFailed('bei-ringkasan', 'em-bei', 'Keterbukaan resmi BEI', BEI_NOTE, 'Indeks keterbukaan BEI'));
    if (sbMeta) body.append(sb ? sbEmitenSection(sb, code) : emFailed('stockbit-ringkasan', 'em-stockbit', 'Diskusi Stockbit', SB_NOTE, 'Indeks ringkasan Stockbit'));
    view.append(body);
    return view;
  }
  function showEmiten(code, routeKey, fresh){
    var cat = beiMeta ? 'bei-ringkasan' : 'stockbit-ringkasan';
    reader.setAttribute('data-cat', cat);
    selectedCategory = document.getElementById(cat) ? cat : selectedCategory; markSource();
    document.title = (code || 'Emiten') + ' · Emiten · ' + siteTitle;
    if (fresh) window.scrollTo(0, 0);
    function status(text){
      reader.replaceChildren(sbEl('div', {'class': 'sb-view em-view'}, emHead(code).concat(
        sbEl('div', {'class': 'doc-loading', role: 'status'}, sbEl('p', null, text)))));
    }
    function live(){ return sbRoute === routeKey && !reader.hidden && !current; }
    if (!code){ status('Tulis kode emiten.'); return; }
    if (!beiMeta && !sbMeta){ status('Indeks ringkasan BEI dan Stockbit belum tersedia di arsip ini.'); return; }
    if ((!beiMeta || beiData) && (!sbMeta || sbData)){ reader.replaceChildren(emitenView(code, beiData, sbData)); return; }
    status('Memuat indeks emiten…');
    function settle(on, loader){ return on ? loader().then(function(d){ return d; }, function(){ return null; }) : Promise.resolve(null); }
    Promise.all([settle(beiMeta, loadBei), settle(sbMeta, loadSb)]).then(function(res){
      if (live()) reader.replaceChildren(emitenView(code, res[0], res[1]));
    });
  }
  // "riwayat lintas hari" di dokumen BEI (judul emiten), dibuat dengan DOM.
  function beiDecorate(root, doc){
    if (!beiMeta || !/^bei-/.test(doc.cat)) return;
    root.querySelectorAll('.emiten-top, .emiten > h3').forEach(function(hd){
      var t = hd.querySelector('.ticker');
      if (t && TICK.test(t.textContent)) hd.append(sbEl('a', {'class': 'sb-hist', href: '#emiten=' + t.textContent}, 'riwayat lintas hari →'));
    });
  }
  document.querySelectorAll('[data-bei-find]').forEach(function(form){
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var v = form.querySelector('input').value.trim().toUpperCase();
      if (/^[A-Z][A-Z0-9]{1,7}$/.test(v)) location.hash = '#emiten=' + v;
    });
  });
  // Tautan "@nama" dan "riwayat lintas hari" di dokumen Stockbit baru, dibuat dengan DOM (teks tetap teks).
  function sbDecorate(root, doc){
    if (!sbMeta || !/^stockbit-/.test(doc.cat)) return;
    root.querySelectorAll('.emiten-top, .emiten > h3').forEach(function(hd){
      var t = hd.querySelector('.ticker');
      if (t && TICK.test(t.textContent)) hd.append(sbEl('a', {'class': 'sb-hist', href: '#emiten=' + t.textContent}, 'riwayat lintas hari →'));
    });
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [], n;
    while ((n = walker.nextNode())) if (n.nodeValue.indexOf('@') !== -1 && !n.parentNode.closest('a,code,pre')) nodes.push(n);
    var re = /(^|[^\w@.])@([A-Za-z0-9_](?:[A-Za-z0-9_.]{0,38}[A-Za-z0-9_])?)/g;
    nodes.forEach(function(node){
      var text = node.nodeValue, frag = document.createDocumentFragment(), last = 0, m;
      re.lastIndex = 0;
      while ((m = re.exec(text))){
        var at = m.index + m[1].length;
        frag.append(text.slice(last, at), sbEl('a', {href: '#pengguna=' + encodeURIComponent(m[2])}, '@' + m[2]));
        last = at + 1 + m[2].length;
      }
      if (!last) return;
      frag.append(text.slice(last));
      node.replaceWith(frag);
    });
  }
  document.querySelectorAll('[data-sb-find]').forEach(function(form){
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var v = form.querySelector('input').value.trim();
      if (v) location.hash = sbHref(v);
    });
  });

  function markSource(){
    sourceNav.querySelectorAll('a').forEach(function(a){
      if (!input.value.trim() && a.getAttribute('data-cat') === selectedCategory) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });
  }

  function filter(){
    var raw = input.value.trim().slice(0,128), q = raw.toLowerCase(), shown = 0;
    docs.forEach(function(d){
      if (d.unlisted) return;  // dipensiunkan: tidak ada di daftar, tetap bisa dibuka lewat #doc=
      var hits = q ? count(d.body, q) : 0;
      var hit = q ? hits > 0 || d.hay.indexOf(q) !== -1 : d.cat === selectedCategory;
      if (hit) shown++;
      d.listNodes.forEach(function(el){
        el.hidden = !hit;
        var h = el.querySelector('.hits');
        if (h) h.textContent = hits ? hits + '× di teks' : '';
      });
    });
    overview.querySelectorAll('.cat,.day').forEach(function(g){
      g.hidden = !g.querySelector('[data-id]:not([hidden])');
    });
    markSource();
    clearSearch.hidden = !q;
    if (raw.length >= 2) loadForSearch();
    var waiting = 0, failed = 0;
    searchLazy.forEach(function(d){ if (d.content == null){ if (d.failed) failed++; else waiting++; } });
    var code = raw.toUpperCase(), ownHint = own && own.tickers.indexOf(code) !== -1 ?
      ' · <a href="#kepemilikan=' + encodeURIComponent(code) + '">Kepemilikan saham ' + esc(code) + ' →</a>' : '';
    var sbHint = '';
    function inDaily(cat){ return docs.some(function(d){ return d.cat === cat && d.tickers.indexOf(code) !== -1; }); }
    var inSb = sbMeta && TICK.test(code) && inDaily('stockbit-ringkasan'), inBei = beiMeta && TICK.test(code) && inDaily('bei-ringkasan');
    if (sbMeta && /^@[A-Za-z0-9_.]{2,64}$/.test(raw)) sbHint = ' · <a href="' + esc(sbHref(raw)) + '">' + esc(raw) + ' di ringkasan Stockbit →</a>';
    else if (inSb || inBei)
      sbHint = ' · <a href="#emiten=' + encodeURIComponent(code) + '">' + esc(code) +
        (inBei && inSb ? ' di keterbukaan BEI dan ringkasan Stockbit →' : inBei ? ' di keterbukaan BEI →' : ' di ringkasan Stockbit →') + '</a>';
    note.innerHTML = q ? esc(shown + ' dari ' + listedCount + ' dokumen (semua sumber) memuat “' + raw + '”' +
      (raw.length >= 2 && waiting ? ' · memuat isi ' + waiting + ' dokumen besar…' : '') +
      (raw.length >= 2 && failed ? ' · isi ' + failed + ' dokumen besar belum dicari' : '')) + ownHint + sbHint +
      (!reader.hidden ? ' · <a href="#">Daftar hasil pencarian →</a>' : '') : '';
    empty.hidden = shown > 0;
    if (current && !reader.hidden && renderedQuery !== raw){
      var frame = reader.querySelector('.doc-frame');
      if (current.kind !== 'html') renderDoc(current, raw); else if (frame) markFrame(frame, current, raw);
    }
  }

  var timer;
  sourceNav.addEventListener('click', function(e){
    var a = e.target.closest('a');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    // Klik sumber yang sudah ada di URL tetap menghapus pencarian dan membuka daftarnya.
    if (location.hash === a.getAttribute('href')){ e.preventDefault(); route(); }
  });
  clearSearch.addEventListener('click', function(){
    clearTimeout(timer); input.value = ''; filter(); input.focus();
  });
  reader.addEventListener('click', function(e){
    if (e.target.closest('[data-retry-doc]') && current) renderDoc(current, input.value.trim());
    if (e.target.closest('[data-sb-retry]')){ route(); return; }
    var btn = e.target.closest('[data-sort-col]'), table = btn && btn.closest('table');
    if (!table || !current) return;
    // Klik pertama: angka terbesar dulu (teks A–Z); klik kedua: sebaliknya; klik ketiga: urutan asli.
    var col = +btn.getAttribute('data-sort-col'), prev = current.sort && current.sort.col === col ? current.sort.dir : '';
    var first = csvIsNumeric(table, col) ? 'descending' : 'ascending', second = first === 'descending' ? 'ascending' : 'descending';
    var dir = !prev ? first : prev === first ? second : '';
    current.sort = dir ? {col: col, dir: dir} : null;
    sortCsv(table, col, dir);
  });
  input.addEventListener('input', function(){ clearTimeout(timer); timer = setTimeout(filter, 140); });
  window.addEventListener('hashchange', route);
  route();
})();
