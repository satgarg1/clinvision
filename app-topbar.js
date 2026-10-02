// Global top bar: the floating profile pill and its account menu, shared by
// every page that has the app sidebar (.app-shell). It is injected here,
// once, instead of being repeated in each page's markup, so all of them get
// an identical bar. Pages without the sidebar (marketing, auth) no-op.
(function () {
  const shell = document.querySelector('.app-shell');
  const main = shell && shell.querySelector(':scope > .app-main');
  if (!shell || !main || !window.Qlinic) return;

  const bar = document.createElement('div');
  bar.className = 'global-topbar';
  // First thing inside the page column, so the pill is part of the page: it
  // sits at the very top, scrolls away with the page, and is found again by
  // scrolling back up. (Mobile pins it over the header strip instead.)
  main.insertBefore(bar, main.firstChild);

  // A classic scrollbar takes width from the page column, so hand its width
  // to the CSS to keep the pill 32px from the window edge on every page,
  // whether or not that page scrolls.
  function fitScrollbar() {
    shell.style.setProperty('--sbw', (main.offsetWidth - main.clientWidth) + 'px');
  }
  fitScrollbar();
  if (window.ResizeObserver) new ResizeObserver(fitScrollbar).observe(main);
  else window.addEventListener('resize', fitScrollbar);

  const AVATAR_COLORS = ['#0f9d94', '#4f46e5', '#c2410c'];
  const PLATFORM_ADMIN_COLOR = '#1e1b4b';

  async function build() {
    const email = await Qlinic.getCurrentUserEmail();
    if (!email) return;

    const onAdminPage = /(^|\/)admin\.html$/.test(location.pathname);
    let clinicName = 'Platform admin';
    if (!onAdminPage) {
      let clinic = null;
      try { clinic = await Qlinic.getClinic(); } catch (err) { }
      clinicName = (clinic && clinic.name) || '';
    }
    const who = await Qlinic.getMyDisplayName();

    bar.innerHTML =
      '<div class="tb-wrap">' +
        '<button type="button" class="tb-pill" aria-expanded="false" aria-controls="tbMenu" aria-label="Account menu">' +
          '<span class="tb-avatar"></span>' +
          '<span class="tb-text"><span class="tb-name"></span><span class="tb-clinic"></span></span>' +
          '<svg class="tb-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>' +
        '</button>' +
        '<div class="tb-menu" id="tbMenu">' +
          '<div class="tb-menu-head"><div class="tb-menu-email"></div><div class="tb-menu-clinic"></div></div>' +
          '<div class="tb-menu-divider"></div>' +
          '<a href="account-security.html" class="tb-menu-row">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>' +
            '<span>Account &amp; security</span>' +
          '</a>' +
          '<div class="tb-menu-divider"></div>' +
          '<a href="#" class="tb-menu-row out" id="tbLogout">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>' +
            '<span>Log out</span>' +
          '</a>' +
        '</div>' +
      '</div>';

    // The platform admin has no clinic profile, so account-security.html
    // (which requires one) would call them deactivated. Log out only.
    if (onAdminPage) {
      bar.querySelector('a[href="account-security.html"]').remove();
      bar.querySelectorAll('.tb-menu-divider')[1].remove();
    }

    const avatar = bar.querySelector('.tb-avatar');
    avatar.textContent = Qlinic.initialsFor(who.text);
    avatar.style.background = onAdminPage ? PLATFORM_ADMIN_COLOR : AVATAR_COLORS[Qlinic.hashIndex(who.text, AVATAR_COLORS.length)];
    bar.querySelector('.tb-name').textContent = who.text;
    bar.querySelector('.tb-clinic').textContent = clinicName;
    bar.querySelector('.tb-menu-email').textContent = email;
    bar.querySelector('.tb-menu-email').title = email;
    bar.querySelector('.tb-menu-clinic').textContent = clinicName;

    // A disclosure (button + panel of ordinary links), not an ARIA menu:
    // it opens on click, closes on outside click, Escape, or focus
    // leaving it, and the links are reachable with Tab like any others.
    const wrap = bar.querySelector('.tb-wrap');
    const pill = bar.querySelector('.tb-pill');
    // Tells the page's first row how much room the pill takes (see .global-topbar in styles.css).
    shell.style.setProperty('--tb-reserve', (pill.offsetWidth + 20) + 'px');
    shell.style.setProperty('--tb-h', pill.offsetHeight + 'px');
    const menu = bar.querySelector('.tb-menu');
    function setOpen(open) {
      menu.classList.toggle('open', open);
      pill.setAttribute('aria-expanded', String(open));
    }
    pill.addEventListener('click', () => setOpen(!menu.classList.contains('open')));
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) setOpen(false);
    });
    wrap.addEventListener('focusout', (e) => {
      if (e.relatedTarget && !wrap.contains(e.relatedTarget)) setOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menu.classList.contains('open')) {
        setOpen(false);
        pill.focus();
      }
    });

    const logout = bar.querySelector('#tbLogout');
    const logoutLabel = logout.querySelector('span');
    logout.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        await Qlinic.logout();
      } catch (err) {
        logoutLabel.textContent = 'Could not log out. Try again.';
        setTimeout(() => { logoutLabel.textContent = 'Log out'; }, 3000);
        return;
      }
      window.location.href = 'login.html';
    });
  }

  build().catch(() => { });

  // ---- Closed day popup -------------------------------------------------
  // Whoever logs in (admin, reception, doctor, pharmacist) is told when the clinic is closed today: a
  // weekly off day from Clinic Settings or a date on the Closed dates page. It shows on the first page
  // opened after logging in and on the first page of each day, once, never on an open day.
  const CLOSURE_SEEN_KEY = 'qlinic_closure_popup_seen';

  async function showClosurePopup() {
    if (!Qlinic.getClosureReasonsFor || location.pathname.endsWith('admin.html')) return;
    const email = await Qlinic.getCurrentUserEmail();
    if (!email) return;
    const today = Qlinic.getTodayDate();
    const mark = email + '|' + today;
    let seen = null;
    try { seen = localStorage.getItem(CLOSURE_SEEN_KEY); } catch (e) { /* storage blocked */ }
    if (seen === mark) return;
    const reasons = await Qlinic.getClosureReasonsFor(today);
    try { localStorage.setItem(CLOSURE_SEEN_KEY, mark); } catch (e) { /* storage blocked */ }
    if (!reasons.length) return;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML =
      '<div class="modal-card holiday-popup-modal" role="alertdialog" aria-modal="true" aria-labelledby="closurePopupTitle">' +
        '<div class="holiday-popup-icon" aria-hidden="true">🗓️</div>' +
        '<h2 class="modal-title" id="closurePopupTitle">The clinic is closed today.</h2>' +
        '<div class="holiday-popup-who">' +
          reasons.map((r) =>
            '<div class="holiday-popup-who-row closure">' +
              '<span class="role-tag ' + (r.kind === 'weekly' ? 'reception' : 'doctor') + '">' + (r.kind === 'weekly' ? 'Weekly off' : 'Holiday') + '</span>' +
              '<span class="holiday-popup-who-name">' + Qlinic.escapeHtml(r.label) + '</span>' +
            '</div>').join('') +
        '</div>' +
        '<button type="button" class="btn-sm primary" id="closurePopupDismiss" style="width:100%;">Got it</button>' +
      '</div>';
    document.body.appendChild(backdrop);
    function cleanup() {
      backdrop.remove();
      document.removeEventListener('keydown', onKeydown);
    }
    function onKeydown(e) { if (e.key === 'Escape') cleanup(); }
    document.addEventListener('keydown', onKeydown);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(); });
    backdrop.querySelector('#closurePopupDismiss').addEventListener('click', cleanup);
    backdrop.querySelector('#closurePopupDismiss').focus();
  }
  showClosurePopup().catch(() => { });

  // ---- Loading skeleton -------------------------------------------------
  // Grey blocks with a light band sweeping across them stand in for the page until its first
  // data has arrived. It stays invisible for the first 0.2 seconds (CSS), so a fast connection
  // never flashes it. If the connection is down, or nothing answers for 10 seconds, it turns
  // into a message with a Retry button. After the page has loaded, a dropped connection shows a
  // slim "Reconnecting" bar instead, and the numbers stay as they were.
  if (!Qlinic.onNetwork || !Qlinic.netState) return;
  const PAGE_KINDS = {
    'dashboard.html': 'dashboard',
    'reception.html': 'panels', 'doctor.html': 'panels', 'prescriptions.html': 'panels',
    'pharmacy.html': 'panels', 'manage-medicines.html': 'panels', 'billing.html': 'panels',
    'billing-consultation.html': 'panels',
    'settings.html': 'forms', 'clinic-settings.html': 'forms', 'team.html': 'forms',
    'manage-doctors.html': 'forms', 'doctor-holidays.html': 'forms', 'closed-dates.html': 'forms',
    'account-security.html': 'forms',
  };
  const page = (location.pathname.split('/').pop() || '').toLowerCase();
  const kind = PAGE_KINDS[page] || 'table';
  const blk = (w, h, extra) => '<div class="sk-b" style="width:' + w + ';height:' + h + 'px;' + (extra || '') + '"></div>';
  const cards = (n, h) => '<div class="sk-grid" style="grid-template-columns:repeat(' + n + ',minmax(0,1fr))">' +
    Array.from({ length: n }, () => '<div class="sk-card" style="height:' + h + 'px"></div>').join('') + '</div>';
  const rows = (n) => Array.from({ length: n }, () =>
    '<div class="sk-row">' + blk('34px', 34, 'border-radius:50%;flex:none') + blk('26%', 14) + blk('18%', 14) + blk('22%', 14) + blk('12%', 14, 'margin-left:auto') + '</div>').join('');
  const LAYOUTS = {
    dashboard: blk('180px', 28) + '<div class="sk-card" style="height:128px"></div>' + cards(6, 104) +
      '<div class="sk-grid" style="grid-template-columns:minmax(0,2.2fr) minmax(0,1fr)"><div class="sk-card sk-pad">' + blk('140px', 16) + rows(4) + '</div><div class="sk-card sk-pad">' + blk('110px', 16) + blk('60px', 34, 'margin-top:14px') + blk('90%', 12, 'margin-top:18px') + blk('90%', 12, 'margin-top:12px') + blk('90%', 12, 'margin-top:12px') + '</div></div>',
    table: blk('180px', 28) + '<div class="sk-grid" style="grid-template-columns:repeat(3,max-content)">' + blk('150px', 40, 'border-radius:99px') + blk('190px', 40, 'border-radius:99px') + blk('120px', 40, 'border-radius:99px') + '</div>' + cards(4, 92) +
      '<div class="sk-card sk-pad">' + blk('160px', 16) + rows(6) + '</div>',
    panels: blk('180px', 28) + '<div class="sk-card sk-pad">' + blk('100%', 44, 'border-radius:99px') + '</div>' +
      '<div class="sk-grid" style="grid-template-columns:minmax(0,1.5fr) minmax(0,1fr)"><div class="sk-card sk-pad">' + blk('150px', 16) + rows(5) + '</div><div class="sk-card sk-pad">' + blk('120px', 16) + blk('100%', 14, 'margin-top:16px') + blk('85%', 14, 'margin-top:12px') + blk('92%', 14, 'margin-top:12px') + '</div></div>',
    forms: blk('180px', 28) + blk('320px', 14) + '<div class="sk-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))"><div class="sk-card sk-pad" style="height:210px">' + blk('140px', 16) + blk('100%', 40, 'margin-top:16px') + blk('100%', 40, 'margin-top:12px') + '</div><div class="sk-card sk-pad" style="height:210px">' + blk('140px', 16) + blk('100%', 40, 'margin-top:16px') + blk('100%', 40, 'margin-top:12px') + '</div></div><div class="sk-card sk-pad" style="height:190px">' + blk('160px', 16) + blk('100%', 40, 'margin-top:16px') + '</div>',
  };

  const overlay = document.createElement('div');
  overlay.className = 'app-skel';
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-label', 'Loading');
  overlay.innerHTML = '<div class="app-skel-note" hidden></div><div class="app-skel-inner">' + LAYOUTS[kind] + '</div>';
  shell.appendChild(overlay);

  const startedAt = Date.now();
  let lastActivity = startedAt;
  let failed = false;
  let finished = false;
  let timer = null;

  function showProblem(title, text, withSkeleton) {
    if (finished) return;
    const note = overlay.querySelector('.app-skel-note');
    if (withSkeleton) {
      note.hidden = false;
      note.innerHTML = '<span><b>' + title + '</b> ' + text + '</span><button type="button">Try again</button>';
      note.querySelector('button').addEventListener('click', () => location.reload());
      return;
    }
    note.hidden = true;
    overlay.querySelector('.app-skel-inner').innerHTML =
      '<div class="sk-fail"><div class="sk-fail-icon"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/><line x1="2" y1="2" x2="22" y2="22"/></svg></div>' +
      '<h2>' + title + '</h2><p>' + text + '</p><button type="button" class="btn-sm primary">Try again</button></div>';
    overlay.querySelector('.sk-fail button').addEventListener('click', () => location.reload());
  }

  function finish() {
    finished = true;
    clearInterval(timer);
    overlay.classList.add('is-leaving');
    setTimeout(() => overlay.remove(), 200);
  }

  let reconnectBar = null;
  Qlinic.onNetwork((event) => {
    lastActivity = Date.now();
    if (!finished) {
      if (event === 'failed') {
        failed = true;
        showProblem("Can't reach ClinVision", 'Check your internet connection. Nothing you entered has been lost.', false);
      }
      return;
    }
    // After the first load: a slim bar while the connection is down.
    if (event === 'failed' && !reconnectBar) {
      reconnectBar = document.createElement('div');
      reconnectBar.className = 'net-bar';
      reconnectBar.setAttribute('role', 'status');
      reconnectBar.innerHTML = '<span class="net-bar-dot"></span>Reconnecting. These numbers may be a little out of date.';
      shell.appendChild(reconnectBar);
    } else if (event === 'ok' && reconnectBar) {
      reconnectBar.remove();
      reconnectBar = null;
    }
  });
  window.addEventListener('online', () => { if (!finished && failed) location.reload(); });

  timer = setInterval(() => {
    if (finished) return;
    const now = Date.now();
    const quiet = Qlinic.netState.pending === 0 && now - lastActivity > 350
      && (Qlinic.netState.started > 0 || now - startedAt > 900);
    if (quiet && !failed) { finish(); return; }
    if (!failed && now - startedAt > 10000) {
      showProblem('Taking longer than usual.', 'Still trying. Check your internet connection.', true);
    }
    // Never hold the page behind the skeleton for ever, whatever a stuck request is doing.
    if (!failed && now - startedAt > 25000) finish();
  }, 120);
})();

