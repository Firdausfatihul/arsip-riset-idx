(function(){
  'use strict';
  var frame = document.getElementById('report-content'), sequence = 0, pending = null;
  window.archiveFind = function(query){
    if (typeof query !== 'string' || query.length > 128) return Promise.resolve(null);
    if (pending) pending.finish(null);
    return new Promise(function(resolve){
      var id = ++sequence, timer = setTimeout(function(){ finish(null); }, 2500);
      function finish(value){ clearTimeout(timer); if (pending && pending.id === id) pending = null; resolve(value); }
      pending = {id:id, finish:finish};
      frame.contentWindow.postMessage({type:'archive:find', id:id, query:query}, '*');
    });
  };
  window.archiveJump = function(){ frame.contentWindow.postMessage({type:'archive:jump',id:sequence}, '*'); };
  window.addEventListener('message', function(event){
    var m = event.data;
    if (event.source !== frame.contentWindow || event.origin !== 'null' || !pending || !m ||
        m.type !== 'archive:found' || m.id !== pending.id || !Number.isInteger(m.total) || m.total < 0 || m.total > 500) return;
    pending.finish(m.total);
  });
  if (window !== window.parent) document.getElementById('report-nav').hidden = true;
})();
