// Every link and button on the marketing pages opens in its own tab, so a visitor never has to
// find their way back to the page they came from. Exceptions: the login, sign up and password
// pages (those stay in the same tab), links that jump within this page, mail and phone links,
// and a link back to the very page being read.
(function () {
  var SAME_TAB = /(^|\/)(login|signup|forgot-password|reset-password)(\.html)?([?#]|$)/i;
  function plain(path) {
    return path.replace(/index\.html$/i, '').replace(/\.html$/i, '').replace(/\/$/, '');
  }
  document.querySelectorAll('a[href]').forEach(function (a) {
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#' || /^(mailto:|tel:|sms:|javascript:)/i.test(href)) return;
    if (SAME_TAB.test(href)) return;
    var url;
    try { url = new URL(a.href, window.location.href); } catch (e) { return; }
    if (url.origin === window.location.origin && plain(url.pathname) === plain(window.location.pathname)) return;
    a.target = '_blank';
    var rel = (a.getAttribute('rel') || '').split(/\s+/).filter(Boolean);
    if (rel.indexOf('noopener') === -1) rel.push('noopener');
    a.setAttribute('rel', rel.join(' '));
  });
})();

(function () {
  var btn = document.querySelector('.mkt-menu-btn');
  var panel = document.querySelector('.mkt-nav-links');
  if (!btn || !panel) return;

  function closeMenu() {
    panel.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }
  btn.setAttribute('aria-expanded', 'false');
  btn.addEventListener('click', function () {
    var open = panel.classList.toggle('open');
    btn.setAttribute('aria-expanded', String(open));
  });

  document.querySelectorAll('.nav-segment-wrap').forEach(function (wrap) {
    var trigger = wrap.querySelector('.nav-hover-trigger');
    if (!trigger) return;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', function () {
      var open = wrap.classList.toggle('open');
      trigger.setAttribute('aria-expanded', String(open));
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenu();
  });
})();
