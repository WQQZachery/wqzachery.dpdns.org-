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

/* Update announcements + changelog (data: /announcements.json, one file in the repo: site/announcements.json).
   - wqzAnnounce(): the shell (app.html) calls this once after the boot animation; shows the newest entry with popup:true
     unless its id is already stored in localStorage 'wqzAnnSeen'. A newer entry (new id) shows again.
   - wqzChangelog() / any [data-changelog] element: full history. Inside the shell's iframes it asks the parent to open it,
     so the dialog covers the whole window (and the tab bar) instead of one pane.
   Dialog: role=dialog + aria-modal, focus trapped, Esc / backdrop / × / 我知道了 close, focus returns, rest of the page inert. */
(function () {
  var KEY = 'wqzAnnSeen', data = null, last = null, srcWin = null, prevOv = '', inerted = [], seenId = '';
  var embedded = false; try { embedded = window.parent !== window && document.documentElement.classList.contains('embed') } catch (e) {}
  function load() {
    if (!data) data = fetch('/announcements.json', { credentials: 'omit' }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json() })
      .then(function (j) { return (j && j.entries || []).filter(function (x) { return x && x.id && x.date }) })
      .catch(function (e) { data = null; throw e });
    return data;
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
  function getSeen() { try { return localStorage.getItem(KEY) || '' } catch (e) { return '' } }
  function setSeen(id) { try { if (id) localStorage.setItem(KEY, id) } catch (e) {} }
  function newest(list) { for (var i = 0; i < list.length; i++) if (list[i].popup) return list[i]; return null }
  function meta(x) {
    var m = el('p', 'wz-anm');
    if (x.version) m.appendChild(el('span', 'wz-anv', 'v' + x.version));
    var t = el('time', null, x.date); t.setAttribute('datetime', x.date); m.appendChild(t);
    return m;
  }
  function items(x) { var ul = el('ul', 'wz-ani'); (x.items || []).forEach(function (s) { ul.appendChild(el('li', null, s)) }); return ul }
  var FOC = 'a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function close() {
    var o = document.getElementById('wz-an'); if (!o || o.dataset.closing) return;
    o.dataset.closing = '1'; setSeen(seenId);
    inerted.forEach(function (n) { n.inert = false }); inerted = [];
    document.documentElement.style.overflow = prevOv;
    o.classList.remove('on');
    var rm = function () { o.remove() };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) rm(); else setTimeout(rm, 200);
    // opened from inside a same-origin iframe (shell pane): inert blurred the opener there, so focus that frame and ask it to refocus its opener
    if (srcWin) [].some.call(document.querySelectorAll('iframe'), function (f) { if (f.contentWindow === srcWin) { last = f; return true } });
    if (last && last.focus && document.contains(last)) try {
      last.focus({ preventScroll: true });
      if (last.tagName === 'IFRAME' && last.contentWindow) last.contentWindow.postMessage({ type: 'wz-an-closed' }, location.origin);
    } catch (e) {}
    last = null; srcWin = null;
  }
  function shell() {
    var o = document.getElementById('wz-an'); if (o) return o;
    last = document.activeElement;
    o = el('div', 'wz-an'); o.id = 'wz-an';
    o.innerHTML = '<div class="wz-anbd" data-x></div><div class="wz-anp" role="dialog" aria-modal="true" aria-labelledby="wz-ant" tabindex="-1">' +
      '<button type="button" class="wz-anx" data-x aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
      '<div class="wz-anh"><p class="wz-ank"></p><h2 id="wz-ant"></h2></div><div class="wz-anb" id="wz-anb" tabindex="0" aria-label="内容"></div><div class="wz-ana"></div></div>';
    o.addEventListener('click', function (e) { if (e.target.closest('[data-x]')) close(); else if (e.target.closest('[data-log]')) history() });
    o.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return }
      if (e.key !== 'Tab') return;
      var p = o.querySelector('.wz-anp'), f = [].slice.call(p.querySelectorAll(FOC)).filter(function (x) { return x.offsetParent !== null });
      if (!f.length) { e.preventDefault(); return }
      var a = f[0], z = f[f.length - 1];
      if (!p.contains(document.activeElement)) { e.preventDefault(); a.focus() }
      else if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus() }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus() }
    });
    [].forEach.call(document.body.children, function (n) { if (!n.inert && n.tagName !== 'SCRIPT') { n.inert = true; inerted.push(n) } });
    document.body.appendChild(o);
    prevOv = document.documentElement.style.overflow; document.documentElement.style.overflow = 'hidden';
    requestAnimationFrame(function () { requestAnimationFrame(function () { o.classList.add('on') }) });
    return o;
  }
  function fill(o, kicker, title, body, actions, focusSel) {
    o.querySelector('.wz-ank').textContent = kicker; o.querySelector('#wz-ant').textContent = title;
    var b = o.querySelector('.wz-anb'); b.replaceChildren.apply(b, body); b.scrollTop = 0;
    var a = o.querySelector('.wz-ana'); a.replaceChildren.apply(a, actions);
    var f = o.querySelector(focusSel) || o.querySelector('.wz-anx'); f && f.focus({ preventScroll: true });
  }
  function btn(text, cls, attr) { var b = el('button', 'wz-btn ' + cls, text); b.type = 'button'; b.setAttribute(attr, ''); return b }
  function announce(x) {
    seenId = x.id;
    var o = shell(); o.querySelector('.wz-anp').setAttribute('aria-describedby', 'wz-anb');
    fill(o, '更新公告', x.title || '网站更新', [meta(x), items(x)], [btn('更新日志', 'wz-an2', 'data-log'), btn('我知道了', 'wz-an1', 'data-x')], '.wz-an1');
  }
  function history() {
    var o = shell(); o.querySelector('.wz-anp').removeAttribute('aria-describedby');
    var st = el('div', 'wz-state', '正在加载…'); st.setAttribute('role', 'status');
    fill(o, '全部更新', '更新日志', [st], [btn('关闭', 'wz-an1', 'data-x')], '.wz-anx');
    load().then(function (list) {
      var n = newest(list); if (n) seenId = n.id;
      var ol = el('ol', 'wz-anl');
      list.forEach(function (x) { var li = el('li'); li.appendChild(meta(x)); li.appendChild(el('h3', null, x.title || '')); li.appendChild(items(x)); ol.appendChild(li) });
      var b = o.querySelector('.wz-anb'); b.replaceChildren(ol);
    }).catch(function () {
      var e = el('div', 'wz-state err', '更新日志加载失败'); e.setAttribute('role', 'alert');
      var r = btn('重试', '', 'data-retry'); r.addEventListener('click', history); e.appendChild(r);
      o.querySelector('.wz-anb').replaceChildren(e); r.focus();
    });
  }
  var opener = null;
  addEventListener('message', function (e) {
    if (e.origin === location.origin && e.data && e.data.type === 'wz-an-closed' && opener && opener.focus) { try { opener.focus({ preventScroll: true }) } catch (x) {} opener = null }
  });
  window.wqzChangelog = function (from) {   // from = the iframe window that asked (shell only)
    if (embedded) { try { opener = document.activeElement; parent.postMessage({ type: 'changelog' }, location.origin); return } catch (e) {} }
    var fresh = !document.getElementById('wz-an');
    history();
    if (fresh && from && from !== window) srcWin = from;
  };
  window.wqzAnnounce = function () {
    if (document.getElementById('wz-an') || document.getElementById('wz-pv')) return Promise.resolve(false);
    return load().then(function (list) {
      var x = newest(list), s = getSeen(); if (!x || s === x.id || s === '*' || document.getElementById('wz-an')) return false;   // '*' = never pop up (set by automated tests)
      announce(x); return true;
    }).catch(function () { return false });
  };
  // Esc also works when focus is not inside the dialog yet (e.g. it was on an element that just became inert)
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && document.getElementById('wz-an')) { e.preventDefault(); close() } });
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-changelog]');
    if (t) { e.preventDefault(); e.stopPropagation(); window.wqzChangelog() }
  }, true);
})();
