/* wqzachery shared helpers (served at /shared.js?v=<hash>):
   - wqzPrivacy(): opens the privacy sheet (/privacy in an iframe), any [data-privacy] element opens it too
   - .em[data-u][data-d]: e-mail addresses assembled by JS (not in the HTML) to reduce scraping */
(function () {
  var post = function (m) { try { if (window.parent !== window) parent.postMessage(m, location.origin) } catch (e) {} };
  var last = null;
  function close() {
    var o = document.getElementById('wz-pv'); if (!o) return;
    o.remove(); document.documentElement.style.overflow = ''; post({ type: 'bar', show: true });
    if (last && last.focus) last.focus();
  }
  window.wqzPrivacy = function () {
    if (document.getElementById('wz-pv')) return;
    last = document.activeElement;
    var o = document.createElement('div'); o.id = 'wz-pv'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true'); o.setAttribute('aria-label', '隐私说明');
    o.innerHTML = '<div class="wz-pvp"><div class="wz-pvh"><span>隐私说明</span><a href="/privacy" target="_blank" rel="noopener">新窗口打开</a><button type="button" class="wz-x" aria-label="关闭隐私说明">×</button></div><iframe src="/privacy?embed=1" title="隐私说明"></iframe></div>';
    o.addEventListener('click', function (e) { if (e.target === o || e.target.closest('.wz-x')) close() });
    o.addEventListener('keydown', function (e) { if (e.key === 'Escape') close() });
    document.body.appendChild(o); document.documentElement.style.overflow = 'hidden'; post({ type: 'bar', show: false });
    setTimeout(function () { var x = o.querySelector('.wz-x'); x && x.focus() }, 30);
  };
  addEventListener('keydown', function (e) { if (e.key === 'Escape' && document.getElementById('wz-pv')) close() });
  addEventListener('message', function (e) { if (e.origin === location.origin && e.data && e.data.type === 'privacy-close') close() });
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-privacy]');
    if (t) { e.preventDefault(); e.stopPropagation(); window.wqzPrivacy() }
  }, true);
  function emails() {
    document.querySelectorAll('.em[data-u][data-d]').forEach(function (el) {
      var a = el.getAttribute('data-u') + '@' + el.getAttribute('data-d');
      if (el.tagName === 'A') { el.href = 'mailto:' + a; if (!el.dataset.keep) el.textContent = a }
      else { var l = document.createElement('a'); l.href = 'mailto:' + a; l.textContent = a; el.textContent = ''; el.appendChild(l) }
      el.querySelectorAll('[data-em]').forEach(function (x) { x.textContent = a });
    });
    document.querySelectorAll('[data-cu][data-cd]').forEach(function (b) { b.setAttribute('data-copy', b.getAttribute('data-cu') + '@' + b.getAttribute('data-cd')) });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', emails); else emails();
  window.wqzEmails = emails;
})();
