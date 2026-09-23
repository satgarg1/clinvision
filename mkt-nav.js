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
