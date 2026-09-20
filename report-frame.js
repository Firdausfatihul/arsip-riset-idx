(function(){
  'use strict';
  var first = null;
  // Keep original in-report anchors inside srcdoc instead of navigating to the wrapper URL.
  document.addEventListener('click', function(event){
    var link = event.target.closest('a[href]');
    if (!link) return;
    var href = link.getAttribute('href');
    if (href.startsWith('#')){
      event.preventDefault();
      var id; try { id = decodeURIComponent(href.slice(1)); } catch (_) { return; }
      var target = document.getElementById(id); if (target) target.scrollIntoView({block:'start'});
    } else if (/^https?:\/\//i.test(href)){
      link.target = '_blank'; link.rel = 'noopener noreferrer';
    } else event.preventDefault();
  });
  // Opaque frames cannot always use the Clipboard API; retain a selectable fallback locally.
  document.addEventListener('click', function(event){
    var button = event.target.closest('[data-copy]');
    if (!button || !/^\d{1,24}$/.test(button.getAttribute('data-copy'))) return;
    event.preventDefault(); event.stopImmediatePropagation();
    var field = document.createElement('input'); field.readOnly = true;
    field.value = button.getAttribute('data-copy'); field.setAttribute('aria-label', 'Nomor postingan untuk disalin');
    button.after(field); field.select();
    try { if (document.execCommand && document.execCommand('copy')) { button.textContent = 'Tersalin'; field.remove(); } }
    catch (_) { /* Selected text remains available for manual copying. */ }
  }, true);
  window.addEventListener('message', function(event){
    var m = event.data;
    if (event.source !== parent || !m || !Number.isSafeInteger(m.id)) return;
    if (m.type === 'archive:jump'){ if (first) first.scrollIntoView({block:'center'}); return; }
    if (m.type !== 'archive:find' || typeof m.query !== 'string' || m.query.length > 128) return;
    document.querySelectorAll('mark.arsip-hit').forEach(function(n){ n.replaceWith(n.textContent); });
    document.body.normalize(); first = null;
    var nodes = [], node, walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while ((node = walker.nextNode())) if (!node.parentElement.closest('script,style,textarea,noscript')) nodes.push(node);
    var query = m.query.toLowerCase(), total = 0;
    if (query.length >= 2) nodes.forEach(function(n){
      if (total >= 500) return;
      var text = n.nodeValue, lower = text.toLowerCase(), at = lower.indexOf(query), pos = 0;
      if (at < 0) return;
      var fragment = document.createDocumentFragment();
      while (at >= 0 && total < 500){
        fragment.appendChild(document.createTextNode(text.slice(pos, at)));
        var mark = document.createElement('mark'); mark.className = 'arsip-hit';
        mark.textContent = text.slice(at, at + query.length); fragment.appendChild(mark);
        first = first || mark; total++; pos = at + query.length; at = lower.indexOf(query, pos);
      }
      fragment.appendChild(document.createTextNode(text.slice(pos))); n.replaceWith(fragment);
    });
    parent.postMessage({type:'archive:found', id:m.id, total:total}, '*');
  });
})();
