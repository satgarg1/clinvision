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
  shell.insertBefore(bar, main);

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
})();
