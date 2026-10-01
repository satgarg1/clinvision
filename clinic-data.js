(function (global) {
  if (!window.SUPABASE_URL || window.SUPABASE_URL.indexOf('YOUR-PROJECT-REF') !== -1) {
    console.error('Qlinic: fill in clinic-config.js with your real Supabase project URL and anon key.');
  }

  const authStorage = {
    _target() {
      return localStorage.getItem('qlinic_remember_me') === '0' ? sessionStorage : localStorage;
    },
    getItem(key) { return this._target().getItem(key); },
    setItem(key, value) { this._target().setItem(key, value); },
    removeItem(key) { this._target().removeItem(key); },
  };

  const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
    auth: { storage: authStorage },
  });

  let currentClinicId = null;
  let currentClinic = null;

  let clientErrorCount = 0;
  const CLIENT_ERROR_CAP = 5;
  function reportClientError(message, stack) {
    if (clientErrorCount >= CLIENT_ERROR_CAP) return;
    clientErrorCount++;
    sb.from('client_errors').insert({
      clinic_id: currentClinicId,
      page: (window.location.pathname.split('/').pop() || 'unknown').split('?')[0],
      message: String(message == null ? 'Unknown error' : message).slice(0, 2000),
      stack: stack ? String(stack).slice(0, 4000) : null,
      user_agent: navigator.userAgent,
    }).then(() => {}, () => {});
  }
  window.addEventListener('error', (e) => {
    reportClientError(e.message, e.error && e.error.stack);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    reportClientError(
      reason && reason.message ? reason.message : String(reason),
      reason && reason.stack
    );
  });

  function escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async function copyToClipboard(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) { }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (err) {
      return false;
    }
  }

  function pagerHtml(page, totalPages) {
    if (totalPages <= 1) return '';
    return `
      <div class="pager">
        <button type="button" class="btn-sm pager-icon-btn" data-pager-action="first" ${page === 1 ? 'disabled' : ''} title="First page">«</button>
        <button type="button" class="btn-sm" data-pager-action="prev" ${page === 1 ? 'disabled' : ''}>‹ Prev</button>
        <span class="pager-label">Page <span class="page-jump-editable" data-pager-jump tabindex="0" title="Click to jump to a page"><span class="num">${page}</span></span> of ${totalPages}</span>
        <button type="button" class="btn-sm" data-pager-action="next" ${page === totalPages ? 'disabled' : ''}>Next ›</button>
        <button type="button" class="btn-sm pager-icon-btn" data-pager-action="last" ${page === totalPages ? 'disabled' : ''} title="Last page">»</button>
      </div>
    `;
  }

  // The app's pages scroll inside .app-main (the body itself never scrolls),
  // so "back to the top" has to move that container, not the window.
  function scrollToTop() {
    const main = document.querySelector('.app-main');
    if (main && main.scrollTo) main.scrollTo({ top: 0, behavior: 'smooth' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function wirePager(containerEl, page, totalPages, pageChanged) {
    if (!containerEl) return;
    // Going to a different page always brings the reader back to the top.
    const onChange = (p) => {
      pageChanged(p);
      if (p !== page) scrollToTop();
    };
    const first = containerEl.querySelector('[data-pager-action="first"]');
    const prev = containerEl.querySelector('[data-pager-action="prev"]');
    const next = containerEl.querySelector('[data-pager-action="next"]');
    const last = containerEl.querySelector('[data-pager-action="last"]');
    const jump = containerEl.querySelector('[data-pager-jump]');
    if (first) first.addEventListener('click', () => onChange(1));
    if (prev) prev.addEventListener('click', () => onChange(Math.max(1, page - 1)));
    if (next) next.addEventListener('click', () => onChange(Math.min(totalPages, page + 1)));
    if (last) last.addEventListener('click', () => onChange(totalPages));
    if (!jump) return;
    function startEdit() {
      jump.innerHTML = `<input type="number" class="page-jump-editable-input" min="1" max="${totalPages}" value="${page}" />`;
      const input = jump.querySelector('input');
      input.focus();
      input.select();
      let committed = false;
      function commit() {
        if (committed) return;
        committed = true;
        const v = Math.min(totalPages, Math.max(1, parseInt(input.value, 10) || page));
        onChange(v);
      }
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') { committed = true; onChange(page); }
      });
      input.addEventListener('blur', commit);
    }
    jump.addEventListener('click', startEdit);
    jump.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit(); }
    });
  }

  const COMMON_WEAK_PASSWORDS = ['password', 'password1', '12345678', '123456789', 'qwertyui', 'letmein1', 'admin123', 'welcome1'];
  function passwordStrength(pw) {
    if (!pw) return { level: 'empty', label: '', percent: 0 };
    if (pw.length < 8) return { level: 'weak', label: 'Too short', percent: 15 };

    let score = 0;
    if (pw.length >= 8) score += 1;
    if (pw.length >= 12) score += 1;
    if (pw.length >= 16) score += 1;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
    if (/\d/.test(pw)) score += 1;
    if (/[^A-Za-z0-9]/.test(pw)) score += 1;

    const lower = pw.toLowerCase();
    if (COMMON_WEAK_PASSWORDS.some((weak) => lower.includes(weak)) || /^(.)\1+$/.test(pw)) {
      score = Math.min(score, 1);
    }

    if (score <= 1) return { level: 'weak', label: 'Weak', percent: 25 };
    if (score <= 3) return { level: 'fair', label: 'Fair', percent: 50 };
    if (score <= 4) return { level: 'good', label: 'Good', percent: 75 };
    return { level: 'strong', label: 'Strong', percent: 100 };
  }

  function attachPasswordMeter(inputEl) {
    if (!inputEl || inputEl.dataset.meterAttached) return;
    inputEl.dataset.meterAttached = '1';
    const wrap = document.createElement('div');
    wrap.className = 'pw-meter-wrap';
    // Hidden until there's something to measure, so an untouched password
    // field reads exactly like every other field in the form instead of
    // showing an empty grey track hanging under it.
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="pw-meter"><div class="pw-meter-bar" id="${inputEl.id}Bar"></div></div>
      <div class="pw-meter-label" id="${inputEl.id}Label"></div>
    `;
    // Sits after the whole field, including the show/hide wrapper when
    // attachPasswordReveal has already run - order of the attach* calls
    // then doesn't matter.
    (inputEl.closest('.pw-reveal-wrap') || inputEl).insertAdjacentElement('afterend', wrap);
    const bar = wrap.querySelector('.pw-meter-bar');
    const label = wrap.querySelector('.pw-meter-label');
    function update() {
      const { level, label: text, percent } = passwordStrength(inputEl.value);
      wrap.hidden = inputEl.value.length === 0;
      bar.style.width = percent + '%';
      bar.className = 'pw-meter-bar' + (level !== 'empty' ? ` pw-meter-${level}` : '');
      label.textContent = text;
      label.className = 'pw-meter-label' + (level !== 'empty' ? ` pw-meter-${level}` : '');
    }
    inputEl.addEventListener('input', update);
    // form.reset() doesn't fire input events, so the meter would otherwise
    // keep showing the last password's strength after a successful submit.
    if (inputEl.form) inputEl.form.addEventListener('reset', () => setTimeout(update, 0));
  }

  // Live "do these two match?" feedback under a confirm-password field, so
  // the user finds out as they type rather than only when they hit submit.
  function attachPasswordConfirm(passwordEl, confirmEl) {
    if (!passwordEl || !confirmEl || confirmEl.dataset.confirmAttached) return;
    confirmEl.dataset.confirmAttached = '1';
    const msg = document.createElement('div');
    msg.className = 'pw-match-msg';
    msg.hidden = true;
    (confirmEl.closest('.pw-reveal-wrap') || confirmEl).insertAdjacentElement('afterend', msg);
    function update() {
      if (confirmEl.value.length === 0) { msg.hidden = true; return; }
      const ok = passwordEl.value === confirmEl.value;
      msg.hidden = false;
      msg.textContent = ok ? 'Passwords match' : 'Passwords do not match yet';
      msg.className = 'pw-match-msg ' + (ok ? 'pw-match-ok' : 'pw-match-no');
    }
    passwordEl.addEventListener('input', update);
    confirmEl.addEventListener('input', update);
    if (confirmEl.form) confirmEl.form.addEventListener('reset', () => setTimeout(update, 0));
  }

  const EYE_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  // A show/hide eye toggle inside any password field. Wraps the input so
  // the button can sit over its right edge, and hides the browsers' own
  // native reveal control (see styles.css) so there's only ever one.
  function attachPasswordReveal(inputEl) {
    if (!inputEl || inputEl.dataset.revealAttached) return;
    inputEl.dataset.revealAttached = '1';
    const wrap = document.createElement('div');
    wrap.className = 'pw-reveal-wrap';
    inputEl.insertAdjacentElement('beforebegin', wrap);
    wrap.appendChild(inputEl);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-reveal-btn';
    wrap.appendChild(btn);
    let shown = false;
    function render() {
      inputEl.type = shown ? 'text' : 'password';
      btn.innerHTML = shown ? EYE_OFF_SVG : EYE_SVG;
      btn.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
      btn.setAttribute('aria-pressed', shown ? 'true' : 'false');
    }
    render();
    btn.addEventListener('click', () => {
      shown = !shown;
      const start = inputEl.selectionStart;
      const end = inputEl.selectionEnd;
      render();
      // keep the caret where it was - toggling .type drops the selection
      try { inputEl.focus(); inputEl.setSelectionRange(start, end); } catch (e) { /* type=email etc. don't allow it */ }
    });
    if (inputEl.form) inputEl.form.addEventListener('reset', () => { shown = false; setTimeout(render, 0); });
  }

  function confirmDialog({ title, message, messageHtml, confirmLabel = 'Continue', cancelLabel = 'Cancel', danger = false } = {}) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      // messageHtml is the escape hatch for a caller that needs inline
      // formatting (e.g. bolding a name inside the sentence) - it's used
      // verbatim, so the CALLER is responsible for escaping any dynamic
      // value it interpolates (with escapeHtml) before building it. Plain
      // message stays auto-escaped as before for every other call site.
      const bodyHtml = messageHtml
        || message.split('\n').map((line) => `<p class="modal-message">${escapeHtml(line)}</p>`).join('');
      backdrop.innerHTML = `
        <div class="modal-card" role="alertdialog" aria-modal="true">
          ${title ? `<h2 class="modal-title">${escapeHtml(title)}</h2>` : ''}
          ${bodyHtml}
          <div class="modal-actions">
            <button type="button" class="btn-sm ${danger ? 'danger-solid' : 'primary'}" id="modalConfirmBtn">${escapeHtml(confirmLabel)}</button>
            <button type="button" class="btn-sm" id="modalCancelBtn">${escapeHtml(cancelLabel)}</button>
          </div>
        </div>
      `;
      document.body.appendChild(backdrop);

      function cleanup(result) {
        backdrop.remove();
        document.removeEventListener('keydown', onKeydown);
        resolve(result);
      }
      function onKeydown(e) {
        if (e.key === 'Escape') cleanup(false);
      }
      document.addEventListener('keydown', onKeydown);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(false); });
      backdrop.querySelector('#modalCancelBtn').addEventListener('click', () => cleanup(false));
      backdrop.querySelector('#modalConfirmBtn').addEventListener('click', () => cleanup(true));
      backdrop.querySelector(danger ? '#modalCancelBtn' : '#modalConfirmBtn').focus();
    });
  }

  function openAdjustBillingModal({ invoice, doctor, onSaved }) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true">
        <h2 class="modal-title">Adjust billing</h2>
        <div class="doctor-form-field" style="margin-bottom:16px;">
          <label>Fee type</label>
          <select id="adjModalFeeType">
            <option value="consultation" ${invoice.feeType === 'consultation' ? 'selected' : ''}>Consultation</option>
            <option value="emergency" ${invoice.feeType === 'emergency' ? 'selected' : ''}>Emergency</option>
            <option value="waived" ${invoice.feeType === 'waived' ? 'selected' : ''}>Follow up</option>
          </select>
        </div>
        <div class="doctor-form-field" style="margin-bottom:16px;">
          <label>Payment mode</label>
          <select id="adjModalPaymentMode">
            <option value="cash" ${invoice.paymentMode === 'cash' ? 'selected' : ''}>Cash</option>
            <option value="upi" ${invoice.paymentMode === 'upi' ? 'selected' : ''}>UPI</option>
            <option value="card" ${invoice.paymentMode === 'card' ? 'selected' : ''}>Card</option>
          </select>
        </div>
        <div class="doctor-form-field" style="margin-bottom:16px;">
          <label>Amount received (&#8377;)</label>
          <input type="number" min="0" step="1" id="adjModalAmount" value="${invoice.amountReceived}" />
        </div>
        <p class="amount-preview" id="adjModalPreview"></p>
        <p class="modal-message" id="adjModalError" style="display:none;color:var(--danger);margin:6px 0 16px;font-size:13px;"></p>
        <div class="modal-actions">
          <button type="button" class="btn-sm primary" id="adjModalSaveBtn">Save</button>
          <button type="button" class="btn-sm" id="adjModalCancelBtn">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const feeNormal = (doctor && doctor.feeNormal) || 0;
    const feeEmergency = (doctor && doctor.feeEmergency) || 0;
    const FEE_LABELS = { consultation: 'Consultation', emergency: 'Emergency', waived: 'Follow-up' };
    const feeTypeSelect = backdrop.querySelector('#adjModalFeeType');
    const amountInput = backdrop.querySelector('#adjModalAmount');
    const preview = backdrop.querySelector('#adjModalPreview');
    function feeForType(t) { return t === 'waived' ? 0 : t === 'emergency' ? feeEmergency : feeNormal; }
    function syncPreview() {
      preview.textContent = doctor
        ? `${FEE_LABELS[feeTypeSelect.value]} fee for ${doctor.name}: ₹${amountInput.value || 0}`
        : `${FEE_LABELS[feeTypeSelect.value]}: ₹${amountInput.value || 0}`;
    }
    feeTypeSelect.addEventListener('change', () => {
      amountInput.value = feeForType(feeTypeSelect.value);
      syncPreview();
    });
    amountInput.addEventListener('input', syncPreview);
    syncPreview();

    function cleanup() {
      backdrop.remove();
      document.removeEventListener('keydown', onKeydown);
    }
    function onKeydown(e) { if (e.key === 'Escape') cleanup(); }
    document.addEventListener('keydown', onKeydown);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(); });
    backdrop.querySelector('#adjModalCancelBtn').addEventListener('click', cleanup);
    backdrop.querySelector('#adjModalSaveBtn').addEventListener('click', async () => {
      const errorEl = backdrop.querySelector('#adjModalError');
      errorEl.style.display = 'none';
      try {
        await updateInvoicePayment({
          invoiceId: invoice.id,
          feeType: feeTypeSelect.value,
          paymentMode: backdrop.querySelector('#adjModalPaymentMode').value,
          amountReceived: amountInput.value,
        });
      } catch (err) {
        errorEl.textContent = err.message || 'Could not update billing — please try again.';
        errorEl.style.display = 'block';
        return;
      }
      cleanup();
      if (onSaved) onSaved();
    });
  }

  function attachDatePicker(input, opts) {
    opts = opts || {};
    if (input._qlinicDatePicker) return input._qlinicDatePicker;
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const DOW_FULL = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    function parseISO(v) {
      if (!v) return null;
      const parts = v.split('-').map(Number);
      if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
      return new Date(parts[0], parts[1] - 1, parts[2]);
    }
    function toISO(d) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    function startOfDay(d) { const c = new Date(d); c.setHours(0, 0, 0, 0); return c; }
    function sameDay(a, b) { return !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
    function fmtShort(d) {
      const today = startOfDay(new Date());
      const tmr = new Date(today); tmr.setDate(tmr.getDate() + 1);
      if (sameDay(d, today)) return `Today, ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
      if (sameDay(d, tmr)) return `Tomorrow, ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
      return `${DOW_FULL[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
    }
    function isDisabled(d) {
      const day = startOfDay(d);
      if (input.min) { const mn = parseISO(input.min); if (mn && day < startOfDay(mn)) return true; }
      if (input.max) { const mx = parseISO(input.max); if (mx && day > startOfDay(mx)) return true; }
      return false;
    }

    const wrap = document.createElement('div');
    wrap.className = 'qdp';
    input.insertAdjacentElement('afterend', wrap);
    input.style.display = 'none';
    input.tabIndex = -1;

    let selected = parseISO(input.value);
    let viewDate = selected ? new Date(selected) : new Date();

    function buildCalendarGrid(gridEl, monthLabelEl) {
      monthLabelEl.textContent = `${MONTHS[viewDate.getMonth()]} ${viewDate.getFullYear()}`;
      gridEl.innerHTML = '';
      const first = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
      const startOffset = first.getDay();
      const daysInMonth = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0).getDate();
      const prevDays = new Date(viewDate.getFullYear(), viewDate.getMonth(), 0).getDate();
      const cells = [];
      for (let i = startOffset - 1; i >= 0; i--) cells.push({ day: prevDays - i, muted: true, date: new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, prevDays - i) });
      for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, muted: false, date: new Date(viewDate.getFullYear(), viewDate.getMonth(), d) });
      let next = 1;
      while (cells.length % 7 !== 0) cells.push({ day: next, muted: true, date: new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, next++) });
      cells.forEach((c) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        const disabled = isDisabled(c.date);
        btn.className = 'qdp-day' + (c.muted ? ' muted' : '') + (sameDay(c.date, new Date()) ? ' today' : '') + (selected && sameDay(c.date, selected) ? ' selected' : '') + (disabled ? ' disabled' : '');
        btn.textContent = c.day;
        if (disabled) { btn.disabled = true; } else { btn.addEventListener('click', () => { commit(c.date); closeAll(); }); }
        gridEl.appendChild(btn);
      });
    }

    let yearPage = 0;
    function buildYearGrid(el) {
      el.innerHTML = '';
      const currentYear = viewDate.getFullYear();
      for (let y = yearPage; y < yearPage + 9; y++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'qdp-grid-cell' + (y === currentYear ? ' selected' : '');
        btn.textContent = y;
        // setDate(1) first: the view only tracks year and month, and keeping
        // a day like the 31st (or Feb 29) makes setFullYear/setMonth overflow
        // into the next month.
        btn.addEventListener('click', () => { viewDate.setDate(1); viewDate.setFullYear(y); showMonthView(); });
        el.appendChild(btn);
      }
    }
    function buildMonthGrid(el) {
      el.innerHTML = '';
      const currentMonth = viewDate.getMonth();
      MONTHS.forEach((name, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'qdp-grid-cell' + (i === currentMonth ? ' selected' : '');
        btn.textContent = name.slice(0, 3);
        btn.addEventListener('click', () => { viewDate.setDate(1); viewDate.setMonth(i); showDayView(); });
        el.appendChild(btn);
      });
    }
    let showDayView = () => {};
    let showYearView = () => {};
    let showMonthView = () => {};

    let closeAll = () => {};
    let triggerEl;
    let pop;
    let onReposition = () => {};

    {
      wrap.innerHTML = `
        <button type="button" class="qdp-trigger">
          <span class="qdp-trigger-label"></span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>
        </button>
        <div class="qdp-pop">
          ${opts.quickButtons === false ? '' : `
          <div class="qdp-quick">
            <button type="button" data-quick="0">Today</button>
            <button type="button" data-quick="1">Tomorrow</button>
            <button type="button" data-quick="7">In a week</button>
          </div>`}
          <div class="qdp-dayview">
            <div class="qdp-head">
              <button type="button" class="qdp-month-label" title="Jump to a different month or year"></button>
              <div class="qdp-nav"><button type="button" data-nav="-1" title="Previous month" aria-label="Previous month">‹</button><button type="button" data-nav="1" title="Next month" aria-label="Next month">›</button></div>
            </div>
            <div class="qdp-dow"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div>
            <div class="qdp-grid"></div>
          </div>
          <div class="qdp-yearview" style="display:none;">
            <div class="qdp-head">
              <span class="qdp-head-title">Select a year</span>
              <div class="qdp-nav"><button type="button" data-yearpage="-9" title="Earlier years" aria-label="Earlier years">‹</button><button type="button" data-yearpage="9" title="Later years" aria-label="Later years">›</button></div>
            </div>
            <div class="qdp-yeargrid"></div>
          </div>
          <div class="qdp-monthview" style="display:none;">
            <div class="qdp-head">
              <button type="button" class="qdp-back">‹ <span class="qdp-back-year"></span></button>
            </div>
            <div class="qdp-monthgrid"></div>
          </div>
        </div>
      `;
      triggerEl = wrap.querySelector('.qdp-trigger');
      pop = wrap.querySelector('.qdp-pop');
      const dayView = pop.querySelector('.qdp-dayview');
      const grid = pop.querySelector('.qdp-grid');
      const monthLabel = pop.querySelector('.qdp-month-label');
      const yearView = pop.querySelector('.qdp-yearview');
      const yearGrid = pop.querySelector('.qdp-yeargrid');
      const monthView = pop.querySelector('.qdp-monthview');
      const monthGrid = pop.querySelector('.qdp-monthgrid');
      const backYearLabel = pop.querySelector('.qdp-back-year');
      // Moved out to <body> (fixed position, see positionPop) so a qtable
      // panel's mobile overflow-x:auto scroll wrapper can't clip a calendar
      // taller than the panel's own content -- same reasoning as the
      // column-filter dropdowns. A modal that later does backdrop.remove()
      // won't reach this now-detached pop, so it's tagged with its wrap
      // and swept on the next open() anywhere on the page.
      document.body.appendChild(pop);
      pop._qdpWrap = wrap;

      function positionPop() {
        const rect = wrap.getBoundingClientRect();
        const flipUp = shouldFlipUp(rect, pop.offsetHeight);
        if (flipUp) {
          pop.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
          pop.style.top = 'auto';
        } else {
          pop.style.top = (rect.bottom + 6) + 'px';
          pop.style.bottom = 'auto';
        }
        pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 264 - 8)) + 'px';
      }
      // Keeps the fixed-position pop glued to its trigger as the page (or
      // a qtable panel's own overflow-x:auto body) scrolls -- without this
      // it stayed put in viewport coordinates while the trigger moved,
      // so it visually detached and could end up over unrelated content.
      onReposition = function () { if (pop.classList.contains('open')) positionPop(); };
      window.addEventListener('scroll', onReposition, true);
      window.addEventListener('resize', onReposition);
      showDayView = function () {
        yearView.style.display = 'none';
        monthView.style.display = 'none';
        dayView.style.display = '';
        buildCalendarGrid(grid, monthLabel);
      };
      showYearView = function () {
        yearPage = Math.floor(viewDate.getFullYear() / 9) * 9;
        dayView.style.display = 'none';
        monthView.style.display = 'none';
        yearView.style.display = '';
        buildYearGrid(yearGrid);
      };
      showMonthView = function () {
        dayView.style.display = 'none';
        yearView.style.display = 'none';
        monthView.style.display = '';
        backYearLabel.textContent = viewDate.getFullYear();
        buildMonthGrid(monthGrid);
      };
      function open() {
        document.querySelectorAll('.qdp-pop.open').forEach((p) => { if (p !== pop) p.classList.remove('open'); });
        document.querySelectorAll('.qdp-pop').forEach((p) => { if (p !== pop && p._qdpWrap && !p._qdpWrap.isConnected) p.remove(); });
        pop.classList.add('open');
        triggerEl.classList.add('open');
        showDayView();
        positionPop();
      }
      function close() { pop.classList.remove('open'); triggerEl.classList.remove('open'); }
      closeAll = close;
      triggerEl.addEventListener('click', (e) => { e.stopPropagation(); pop.classList.contains('open') ? close() : open(); });
      pop.querySelectorAll('[data-nav]').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); viewDate.setDate(1); viewDate.setMonth(viewDate.getMonth() + Number(btn.dataset.nav)); buildCalendarGrid(grid, monthLabel); }));
      pop.querySelectorAll('[data-quick]').forEach((btn) => btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const d = startOfDay(new Date()); d.setDate(d.getDate() + Number(btn.dataset.quick));
        if (isDisabled(d)) return;
        viewDate = new Date(d);
        commit(d);
        close();
      }));
      monthLabel.addEventListener('click', (e) => { e.stopPropagation(); showYearView(); });
      pop.querySelectorAll('[data-yearpage]').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); yearPage += Number(btn.dataset.yearpage); buildYearGrid(yearGrid); }));
      pop.querySelector('.qdp-back').addEventListener('click', (e) => { e.stopPropagation(); showYearView(); });
      pop.addEventListener('click', (e) => e.stopPropagation());
      document.addEventListener('click', close);

      function updateLabel() {
        wrap.querySelector('.qdp-trigger-label').textContent = selected ? fmtShort(selected) : (opts.placeholder || 'Pick a date');
        wrap.querySelector('.qdp-trigger-label').classList.toggle('qdp-placeholder', !selected);
        pop.querySelectorAll('[data-quick]').forEach((btn) => {
          const d = startOfDay(new Date()); d.setDate(d.getDate() + Number(btn.dataset.quick));
          btn.style.display = isDisabled(d) ? 'none' : '';
          btn.classList.toggle('selected', !!selected && sameDay(d, selected));
        });
      }
      var updateLabelFn = updateLabel;
    }

    const nativeValueDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    function commit(d) {
      selected = d;
      nativeValueDesc.set.call(input, d ? toISO(d) : '');
      updateLabelFn();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function syncFromInput() {
      selected = parseISO(nativeValueDesc.get.call(input));
      viewDate = new Date(selected || new Date());
      updateLabelFn();
    }
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() { return nativeValueDesc.get.call(input); },
      set(v) { nativeValueDesc.set.call(input, v); syncFromInput(); },
    });
    input.focus = () => triggerEl.focus();

    updateLabelFn();
    const api = {
      setValue(d) { commit(d); },
      refresh: syncFromInput,
      destroy() {
        window.removeEventListener('scroll', onReposition, true);
        window.removeEventListener('resize', onReposition);
        document.removeEventListener('click', closeAll);
        pop.remove();
        wrap.remove();
        input.style.display = '';
        delete input._qlinicDatePicker;
      },
    };
    input._qlinicDatePicker = api;
    return api;
  }

  // Shared by attachDatePicker's own positionPop() below and by the plain
  // .time-picker-panel dropdowns in reception.html/clinic-settings.html --
  // one place for the "flip above the trigger when there isn't room below
  // and there's more room above" decision, instead of three copies of the
  // same formula.
  function shouldFlipUp(triggerRect, estimatedHeight) {
    const spaceBelow = window.innerHeight - triggerRect.bottom;
    const spaceAbove = triggerRect.top;
    return spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
  }

  function parseTime(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  }

  function formatTime(totalMins) {
    totalMins = ((totalMins % 1440) + 1440) % 1440;
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    const period = h < 12 ? 'AM' : 'PM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${period}`;
  }

  function formatHHMM(totalMins) {
    const wrapped = ((totalMins % 1440) + 1440) % 1440;
    const h = String(Math.floor(wrapped / 60)).padStart(2, '0');
    const m = String(wrapped % 60).padStart(2, '0');
    return `${h}:${m}`;
  }

  function formatTimestamp(value) {
    if (!value) return '·';
    const date = value instanceof Date ? value : new Date(value);
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function formatDateTime(value) {
    if (!value) return '·';
    const date = value instanceof Date ? value : new Date(value);
    return date.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  // The clinic day is the India day, whatever time zone this device is set to: the database
  // and the queue functions all count days in Asia/Kolkata.
  const IST_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
  function todayDateStr() {
    return IST_DATE_FORMAT.format(new Date());
  }

  function formatDateLabel(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const target = new Date(y, m - 1, d);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((target - today) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Tomorrow';
    return target.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function isPastRealDateTime(dateStr, timeStr) {
    const target = new Date(`${dateStr}T${timeStr}:00`);
    return target.getTime() < Date.now();
  }

  function bucketStartMinutes(hhmm, intervalMins) {
    return Math.floor(parseTime(hhmm) / intervalMins) * intervalMins;
  }

  function intendedMoment(patient) {
    if (patient.bookedDate && patient.bookedTime) {
      return new Date(`${patient.bookedDate}T${patient.bookedTime}`);
    }
    return patient.arrivedAt ? new Date(patient.arrivedAt) : new Date();
  }

  function effectiveMoment(patient, doctor) {
    let moment = intendedMoment(patient);
    if (doctor && doctor.delayMins) {
      const availableAgain = new Date(doctor.statusUpdatedAt);
      availableAgain.setMinutes(availableAgain.getMinutes() + doctor.delayMins);
      if (availableAgain > moment) moment = availableAgain;
    }
    if (patient.arrivedAt) {
      const arrived = new Date(patient.arrivedAt);
      if (arrived > moment) moment = arrived;
    }
    return moment;
  }

  function compareQueueOrder(a, b, doctor) {
    if (!!a.isPriority !== !!b.isPriority) return a.isPriority ? -1 : 1;
    const diff = effectiveMoment(a, doctor) - effectiveMoment(b, doctor);
    if (diff) return diff;
    const intentDiff = intendedMoment(a) - intendedMoment(b);
    if (intentDiff) return intentDiff;
    return new Date(a.createdAt) - new Date(b.createdAt);
  }

  function normalizeDoctor(row) {
    return {
      id: row.id,
      name: row.name,
      specialty: row.specialty,
      status: row.status,
      delayMins: row.delay_mins,
      statusNote: row.status_note,
      statusUpdatedAt: row.status_updated_at,
      isActive: row.is_active,
      feeNormal: row.fee_normal,
      feeEmergency: row.fee_emergency,
      dayClosedAt: row.day_closed_at,
      hprId: row.hpr_id,
      qualification: row.qualification || '',
      registrationNumber: row.registration_number || '',
      gender: row.gender || '',
    };
  }

  function normalizePatient(row) {
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      address: row.address,
      age: row.age,
      gender: row.gender,
      type: row.type,
      doctorId: row.doctor_id,
      bookedDate: row.booked_date,
      bookedTime: row.booked_time ? row.booked_time.slice(0, 5) : null,
      status: row.status,
      arrivedAt: row.arrived_at,
      calledAt: row.called_at,
      doneAt: row.done_at,
      reason: row.reason,
      tokenNumber: row.token_number,
      tokenDate: row.token_date,
      isPriority: row.is_priority,
      createdAt: row.created_at,
    };
  }

  const INDIA_STATES_AND_UTS = [
    'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar',
    'Chandigarh', 'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa',
    'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka',
    'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
    'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
    'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  ];

  async function lookupCityStateForPincode(pincode) {
    const clean = (pincode || '').trim();
    if (!/^\d{6}$/.test(clean)) return { city: '', state: '' };
    try {
      const res = await fetch(`https://api.postalpincode.in/pincode/${clean}`);
      if (!res.ok) return { city: '', state: '' };
      const data = await res.json();
      const entry = data && data[0];
      if (!entry || entry.Status !== 'Success' || !entry.PostOffice || !entry.PostOffice.length) return { city: '', state: '' };
      const office = entry.PostOffice[0];
      return { city: office.District || '', state: office.State || '' };
    } catch (e) {
      return { city: '', state: '' };
    }
  }

  async function ensureClinicContext() {
    if (currentClinicId) return currentClinicId;
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;
    const { data, error } = await sb.from('profiles').select('clinic_id').eq('id', session.user.id).maybeSingle();
    if (error) throw error;
    currentClinicId = data ? data.clinic_id : null;
    return currentClinicId;
  }

  async function finishClinicSetupIfNeeded(session) {
    const { data: existing, error } = await sb.from('profiles').select('clinic_id').eq('id', session.user.id).maybeSingle();
    if (error) throw error;
    if (existing) { currentClinicId = existing.clinic_id; return; }
    const pendingName = session.user.user_metadata && session.user.user_metadata.pending_clinic_name;
    if (pendingName) {
      const { data: clinicId, error: rpcError } = await sb.rpc('register_clinic', { clinic_name: pendingName });
      if (rpcError) throw rpcError;
      currentClinicId = clinicId;
      const pendingAddress = session.user.user_metadata && session.user.user_metadata.pending_clinic_address;
      const pendingPhone = session.user.user_metadata && session.user.user_metadata.pending_clinic_phone;
      if (pendingAddress || pendingPhone) {
        await updateClinic({
          addressLine: pendingAddress ? pendingAddress.addressLine : undefined,
          city: pendingAddress ? pendingAddress.city : undefined,
          pincode: pendingAddress ? pendingAddress.pincode : undefined,
          state: pendingAddress ? pendingAddress.state : undefined,
          phone: pendingPhone || undefined,
        });
      }
    }
  }

  async function getClinic(forceRefresh) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return null;
    if (!forceRefresh && currentClinic && currentClinic.id === clinicId) return currentClinic;
    const { data, error } = await sb.from('clinics').select('*').eq('id', clinicId).single();
    if (error) throw error;
    currentClinic = data;
    return currentClinic;
  }

  async function updateClinic(fields) {
    const clinicId = await ensureClinicContext();
    const payload = {};
    if (fields.name !== undefined) payload.name = fields.name;
    if (fields.graceWindowMins !== undefined) payload.grace_window_mins = Number(fields.graceWindowMins);
    if (fields.slotIntervalMins !== undefined) payload.slot_interval_mins = Number(fields.slotIntervalMins);
    if (fields.slotCapacity !== undefined) payload.slot_capacity = Number(fields.slotCapacity);
    if (fields.scheduleIntervalMins !== undefined) payload.schedule_interval_mins = Number(fields.scheduleIntervalMins);
    if (fields.followUpBufferDays !== undefined) payload.follow_up_buffer_days = Number(fields.followUpBufferDays);
    if (fields.openingTime !== undefined) payload.opening_time = fields.openingTime;
    if (fields.closingTime !== undefined) payload.closing_time = fields.closingTime;
    if (fields.weeklyOffDays !== undefined) payload.weekly_off_days = (fields.weeklyOffDays && fields.weeklyOffDays.length) ? fields.weeklyOffDays : null;
    if (fields.displayLanguage !== undefined) payload.display_language = fields.displayLanguage;
    if (fields.addressLine !== undefined) payload.address_line = fields.addressLine;
    if (fields.city !== undefined) payload.city = fields.city;
    if (fields.pincode !== undefined) payload.pincode = fields.pincode;
    if (fields.state !== undefined) payload.state = fields.state;
    if (fields.phone !== undefined) payload.phone = fields.phone;
    if (fields.gstin !== undefined) payload.gstin = fields.gstin || null;
    if (fields.hfrId !== undefined) payload.hfr_id = fields.hfrId || null;
    if (fields.logoUrl !== undefined) payload.logo_url = fields.logoUrl;
    if (fields.whatsappConfirmEnabled !== undefined) payload.whatsapp_confirm_enabled = !!fields.whatsappConfirmEnabled;
    if (fields.reviewLinkUrl !== undefined) {
      // Patients are sent to this URL, so only a real web link is accepted
      // (a javascript: or data: value must never be stored or opened).
      const reviewUrl = (fields.reviewLinkUrl || '').trim();
      if (reviewUrl && !/^https?:\/\//i.test(reviewUrl)) {
        throw new Error('The review link must start with http:// or https://');
      }
      payload.review_link_url = reviewUrl || null;
    }
    // .select('id') so a write the row-level policy silently filtered out
    // (a non-admin login) is reported instead of looking like a success.
    const { data, error } = await sb.from('clinics').update(payload).eq('id', clinicId).select('id');
    if (error) throw error;
    if (!data || !data.length) throw new Error('Only a clinic admin can change these settings.');
    currentClinic = null;
  }

  const LOGO_BUCKET = 'clinic-logos';
  const MAX_LOGO_BYTES = 2 * 1024 * 1024;

  async function uploadClinicLogo(file) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) throw new Error('No clinic to upload a logo for yet.');
    if (file.size > MAX_LOGO_BYTES) throw new Error('Logo must be under 2 MB.');
    const path = `${clinicId}/logo`;
    const { error: uploadError } = await sb.storage.from(LOGO_BUCKET).upload(path, file, {
      upsert: true, cacheControl: '3600', contentType: file.type,
    });
    if (uploadError) throw uploadError;
    const { data } = sb.storage.from(LOGO_BUCKET).getPublicUrl(path);
    const url = `${data.publicUrl}?t=${Date.now()}`;
    await updateClinic({ logoUrl: url });
    return url;
  }

  async function removeClinicLogo() {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return;
    await sb.storage.from(LOGO_BUCKET).remove([`${clinicId}/logo`]);
    await updateClinic({ logoUrl: null });
  }

  function normalizeClosure(row) {
    return { id: row.id, date: row.closure_date, note: row.note || '' };
  }

  async function getClinicClosures() {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    const { data, error } = await sb.from('clinic_closures').select('*')
      .eq('clinic_id', clinicId)
      .order('closure_date');
    if (error) throw error;
    return data.map(normalizeClosure);
  }

  async function addClinicClosure({ date, note }) {
    const clinicId = await ensureClinicContext();
    const { data, error } = await sb.from('clinic_closures').insert({
      clinic_id: clinicId, closure_date: date, note: note || '',
    }).select().single();
    if (error) throw error;
    return normalizeClosure(data);
  }

  async function updateClinicClosure(closureId, { date, note }) {
    const { data, error } = await sb.from('clinic_closures').update({
      closure_date: date, note: note || '',
    }).eq('id', closureId).select().single();
    if (error) throw error;
    return normalizeClosure(data);
  }

  async function deleteClinicClosure(closureId) {
    const { error } = await sb.from('clinic_closures').delete().eq('id', closureId);
    if (error) throw error;
  }

  function normalizeDoctorHoliday(row) {
    return { id: row.id, doctorId: row.doctor_id, date: row.holiday_date, note: row.note || '' };
  }

  async function getDoctorHolidays(doctorId) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    let query = sb.from('doctor_holidays').select('*').eq('clinic_id', clinicId);
    if (doctorId) query = query.eq('doctor_id', doctorId);
    const { data, error } = await query.order('holiday_date');
    if (error) throw error;
    return data.map(normalizeDoctorHoliday);
  }

  async function addDoctorHoliday({ doctorId, date, note }) {
    const clinicId = await ensureClinicContext();
    const { data, error } = await sb.from('doctor_holidays').insert({
      clinic_id: clinicId, doctor_id: doctorId, holiday_date: date, note: note || '',
    }).select().single();
    if (error) throw error;
    return normalizeDoctorHoliday(data);
  }

  async function updateDoctorHoliday(holidayId, { date, note }) {
    const { data, error } = await sb.from('doctor_holidays').update({
      holiday_date: date, note: note || '',
    }).eq('id', holidayId).select().single();
    if (error) throw error;
    return normalizeDoctorHoliday(data);
  }

  async function deleteDoctorHoliday(holidayId) {
    const { error } = await sb.from('doctor_holidays').delete().eq('id', holidayId);
    if (error) throw error;
  }

  function normalizeStaffHoliday(row) {
    return { id: row.id, profileId: row.profile_id, date: row.holiday_date, note: row.note || '' };
  }

  async function getStaffHolidays(profileId) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    let query = sb.from('staff_holidays').select('*').eq('clinic_id', clinicId);
    if (profileId) query = query.eq('profile_id', profileId);
    const { data, error } = await query.order('holiday_date');
    if (error) throw error;
    return data.map(normalizeStaffHoliday);
  }

  async function addStaffHoliday({ profileId, date, note }) {
    const clinicId = await ensureClinicContext();
    const { data, error } = await sb.from('staff_holidays').insert({
      clinic_id: clinicId, profile_id: profileId, holiday_date: date, note: note || '',
    }).select().single();
    if (error) throw error;
    return normalizeStaffHoliday(data);
  }

  async function updateStaffHoliday(holidayId, { date, note }) {
    const { data, error } = await sb.from('staff_holidays').update({
      holiday_date: date, note: note || '',
    }).eq('id', holidayId).select().single();
    if (error) throw error;
    return normalizeStaffHoliday(data);
  }

  async function deleteStaffHoliday(holidayId) {
    const { error } = await sb.from('staff_holidays').delete().eq('id', holidayId);
    if (error) throw error;
  }

  async function getDoctors(opts) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    let query = sb.from('doctors').select('*').eq('clinic_id', clinicId);
    if (!(opts && opts.includeInactive)) query = query.eq('is_active', true);
    const { data, error } = await query.order('created_at');
    if (error) throw error;
    return data.map(normalizeDoctor);
  }

  async function getDoctor(doctorId) {
    if (!doctorId) return null;
    const { data, error } = await sb.from('doctors').select('*').eq('id', doctorId).maybeSingle();
    if (error) throw error;
    return data ? normalizeDoctor(data) : null;
  }

  // Doctors are saved without a title; every screen adds "Dr." itself, so a typed one would show twice.
  function plainDoctorName(name) {
    const typed = String(name || '').trim();
    return typed.replace(/^dr\.?\s+/i, '').trim() || typed;
  }

  async function addDoctor({ name, specialty, feeNormal, feeEmergency, hprId, qualification, registrationNumber, gender }) {
    const clinicId = await ensureClinicContext();
    const { data, error } = await sb.from('doctors').insert({
      clinic_id: clinicId, name: plainDoctorName(name), specialty: specialty || '',
      fee_normal: feeNormal || 0, fee_emergency: feeEmergency || 0,
      hpr_id: hprId || null,
      qualification: qualification || '', registration_number: registrationNumber || '',
      gender: gender === 'male' || gender === 'female' ? gender : null,
    }).select().single();
    if (error) throw error;
    return normalizeDoctor(data);
  }

  async function updateDoctor(doctorId, { name, specialty, feeNormal, feeEmergency, hprId, qualification, registrationNumber, gender }) {
    const { error } = await sb.from('doctors').update({
      name: plainDoctorName(name), specialty: specialty || '',
      fee_normal: feeNormal || 0, fee_emergency: feeEmergency || 0,
      hpr_id: hprId || null,
      qualification: qualification || '', registration_number: registrationNumber || '',
      gender: gender === 'male' || gender === 'female' ? gender : null,
    }).eq('id', doctorId);
    if (error) throw error;
  }

  async function setDoctorActive(doctorId, isActive) {
    const { error } = await sb.rpc('set_doctor_active_cascade', {
      target_doctor_id: doctorId,
      new_active: isActive,
    });
    if (error) throw error;
  }

  function doctorLabel(doctor) {
    if (!doctor) return '';
    return doctor.isActive === false ? `${doctor.name} (Inactive)` : doctor.name;
  }

  async function fetchPatientsForDoctorAndDate(doctorId, dateStr) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    const { data, error } = await sb.from('patients').select('*')
      .eq('clinic_id', clinicId)
      .eq('doctor_id', doctorId)
      .eq('token_date', dateStr);
    if (error) throw error;
    return data.map(normalizePatient);
  }

  async function getQueueForDoctor(doctorId, dateStr, doctorHint) {
    const targetDate = dateStr || todayDateStr();
    const [doctor, mine] = await Promise.all([
      doctorHint || getDoctor(doctorId),
      fetchPatientsForDoctorAndDate(doctorId, targetDate),
    ]);

    const nowServing = mine.find((p) => p.status === 'in_consult') || null;

    const waiting = mine
      .filter((p) => p.status === 'waiting')
      .sort((a, b) => compareQueueOrder(a, b, doctor))
      .map((p, idx) => Object.assign({}, p, { position: idx + 1, effectiveTime: effectiveMoment(p, doctor), intendedTime: intendedMoment(p) }));

    const booked = mine
      .filter((p) => p.status === 'booked')
      .sort((a, b) => compareQueueOrder(a, b, doctor))
      .map((p) => Object.assign({}, p, {
        effectiveTime: effectiveMoment(p, doctor),
      }));

    const done = mine.filter((p) => p.status === 'done');
    const noShow = mine.filter((p) => p.status === 'no_show');
    return { nowServing, waiting, booked, done, noShow };
  }

  async function getAllQueues(dateStr) {
    const doctors = await getDoctors();
    const queues = await Promise.all(doctors.map((d) => getQueueForDoctor(d.id, dateStr, d)));
    return doctors.map((d, i) => ({ doctor: d, queue: queues[i] }));
  }

  // Staff-side: today's deterministic day-code for this clinic (the QR
  // the board shows). No expiry math on this end at all — it's the
  // same value all "board day" (2am-2am), a different value once the
  // day rolls over, so the TV can just re-fetch it freely with no risk
  // of handing out a near-dead value.
  async function getDailyBoardCode() {
    const { data, error } = await sb.rpc('get_daily_board_code');
    if (error) throw error;
    return { clinicId: data.clinicId, code: data.code };
  }

  // Patient-side, step 1: exchange a scanned day-code for this specific
  // phone's own 4-hour session, anchored to the moment of this call —
  // not to the day-code's own rotation, so a patient's visit never
  // breaks just because the wall-clock crossed 2am while they waited.
  async function redeemDailyBoardCode(clinicId, code) {
    const { data, error } = await sb.rpc('redeem_daily_board_code', { p_clinic_id: clinicId, p_code: code });
    if (error) throw error;
    if (!data || data.error) {
      const err = new Error('This QR code is no longer valid — please scan the one currently on screen.');
      err.code = 'DISPLAY_CODE_INVALID';
      throw err;
    }
    return { sessionId: data.sessionId, expiresAt: data.expiresAt };
  }

  // Patient-side, step 2: same shape getAllQueues() returns
  // ([{doctor, queue: {nowServing, waiting, booked, done, noShow}}]),
  // built from the session-scoped public RPC instead of an
  // authenticated session, so display.html's existing render functions
  // work unchanged regardless of which path supplied the data.
  async function getDisplayBoardBySession(sessionId, dateStr) {
    const targetDate = dateStr || todayDateStr();
    const { data, error } = await sb.rpc('get_display_board_by_session', { p_session_id: sessionId, p_date: targetDate });
    if (error) throw error;
    if (!data || data.error) {
      const err = new Error('Your session has ended — please scan the QR code again.');
      err.code = 'DISPLAY_SESSION_EXPIRED';
      throw err;
    }
    const clinic = data.clinic;
    const doctors = (data.doctors || []).map(normalizeDoctor);
    const patientsByDoctor = {};
    (data.patients || []).forEach((row) => {
      const p = normalizePatient(row);
      (patientsByDoctor[p.doctorId] = patientsByDoctor[p.doctorId] || []).push(p);
    });
    const allQueues = doctors.map((doctor) => {
      const mine = patientsByDoctor[doctor.id] || [];
      const nowServing = mine.find((p) => p.status === 'in_consult') || null;
      const waiting = mine
        .filter((p) => p.status === 'waiting')
        .sort((a, b) => compareQueueOrder(a, b, doctor))
        .map((p, idx) => Object.assign({}, p, { position: idx + 1, effectiveTime: effectiveMoment(p, doctor), intendedTime: intendedMoment(p) }));
      const booked = mine
        .filter((p) => p.status === 'booked')
        .sort((a, b) => compareQueueOrder(a, b, doctor))
        .map((p) => Object.assign({}, p, { effectiveTime: effectiveMoment(p, doctor) }));
      const done = mine.filter((p) => p.status === 'done');
      const noShow = mine.filter((p) => p.status === 'no_show');
      return { doctor, queue: { nowServing, waiting, booked, done, noShow } };
    });
    return { clinic, allQueues };
  }

  function escapeOrFilterValue(v) {
    return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  async function searchBookedPatients(query) {
    const clinicId = await ensureClinicContext();
    const q = query.trim();
    if (!q || !clinicId) return [];
    const today = todayDateStr();
    const doctors = await getDoctors();
    const doctorById = Object.fromEntries(doctors.map((d) => [d.id, d]));
    const nameFilter = escapeOrFilterValue(`%${q}%`);
    const { data, error } = await sb
      .from('patients')
      .select('*')
      .eq('clinic_id', clinicId)
      .in('status', ['booked', 'waiting', 'no_show'])
      .eq('token_date', today)
      .or(`name.ilike.${nameFilter},phone.ilike.${nameFilter}`);
    if (error) throw error;
    return data.map(normalizePatient).map((p) => Object.assign({}, p, {
      effectiveTime: effectiveMoment(p, doctorById[p.doctorId]),
    })).sort((a, b) => a.effectiveTime - b.effectiveTime);
  }

  async function updatePatientContact(patientId, { name, phone, doctorId, bookedDate, bookedTime }) {
    const payload = {};
    if (name !== undefined) payload.name = name;
    if (phone !== undefined) payload.phone = phone;
    if (doctorId !== undefined) payload.doctor_id = doctorId;
    if (bookedDate !== undefined) { payload.booked_date = bookedDate; payload.token_date = bookedDate; }
    if (bookedTime !== undefined) payload.booked_time = bookedTime;
    const { error } = await sb.from('patients').update(payload).eq('id', patientId);
    if (error) throw error;
  }

  // The status guards make these compare-and-set: a stale row behind an
  // open confirm dialog, or a second receptionist, can no longer push a
  // patient who is already in consultation or done back to waiting/no_show.
  async function markArrived(patientId) {
    const { data, error } = await sb.from('patients')
      .update({ status: 'waiting', arrived_at: new Date().toISOString() })
      .eq('id', patientId).in('status', ['booked', 'no_show'])
      .select('id');
    if (error) throw error;
    if (!data || !data.length) throw new Error('This patient was already updated by someone else. Refresh to see the latest.');
  }

  async function markNoShow(patientId) {
    const { data, error } = await sb.from('patients')
      .update({ status: 'no_show' })
      .eq('id', patientId).in('status', ['booked', 'waiting'])
      .select('id');
    if (error) throw error;
    if (!data || !data.length) throw new Error('This patient was already updated by someone else. Refresh to see the latest.');
  }

  async function addWalkIn(info) {
    const clinicId = await ensureClinicContext();
    const { data, error } = await sb.from('patients').insert({
      clinic_id: clinicId,
      doctor_id: info.doctorId,
      name: info.name,
      phone: info.phone,
      address: info.address || '',
      age: (info.age === undefined || info.age === '') ? null : info.age,
      gender: info.gender || 'other',
      type: 'walkin',
      status: 'waiting',
      arrived_at: new Date().toISOString(),
      reason: info.reason || '',
      token_date: todayDateStr(),
      booked_date: info.bookedTime ? todayDateStr() : null,
      booked_time: info.bookedTime || null,
      is_priority: !!info.isPriority,
    }).select().single();
    if (error) throw error;
    const message = await queueBookingNotification({
      patientId: data.id, phone: info.phone, doctorId: info.doctorId, kind: 'walkin', tokenNumber: data.token_number,
    });
    return { id: data.id, message, tokenNumber: data.token_number };
  }

  async function addAppointment(info) {
    const clinicId = await ensureClinicContext();
    const { data, error } = await sb.from('patients').insert({
      clinic_id: clinicId,
      doctor_id: info.doctorId,
      name: info.name,
      phone: info.phone,
      address: info.address || '',
      age: (info.age === undefined || info.age === '') ? null : info.age,
      gender: info.gender || 'other',
      type: 'appointment',
      booked_date: info.bookedDate,
      booked_time: info.bookedTime,
      status: 'booked',
      reason: info.reason || '',
      token_date: info.bookedDate,
    }).select().single();
    if (error) throw error;
    const message = await queueBookingNotification({
      patientId: data.id, phone: info.phone, doctorId: info.doctorId, kind: 'appointment',
      bookedDate: info.bookedDate, bookedTime: info.bookedTime, tokenNumber: data.token_number,
    });
    return { id: data.id, message, tokenNumber: data.token_number };
  }

  async function getPatientLookupByPhone(phone) {
    const clinicId = await ensureClinicContext();
    const cleanPhone = (phone || '').trim();
    if (!clinicId || !cleanPhone) return null;
    const { data, error } = await sb
      .from('patients')
      .select('name, gender, address, age, status, token_date, doctor_id')
      .eq('clinic_id', clinicId)
      .eq('phone', cleanPhone)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    if (!data || data.length === 0) return null;
    const latest = data[0];
    const lastFive = data.slice(0, 5);
    const visited = data.filter((p) => ['waiting', 'in_consult', 'done'].includes(p.status));
    const recentVisits = visited
      .slice()
      .sort((a, b) => (a.token_date > b.token_date ? -1 : a.token_date < b.token_date ? 1 : 0))
      .slice(0, 3)
      .map((p) => ({ date: p.token_date, doctorId: p.doctor_id }));
    return {
      name: latest.name,
      gender: latest.gender,
      address: latest.address,
      age: latest.age,
      visitsChecked: lastFive.length,
      noShowCount: lastFive.filter((p) => p.status === 'no_show').length,
      totalVisits: visited.length,
      recentVisits,
    };
  }

  async function fetchAllRows(buildQuery, pageSize) {
    pageSize = pageSize || 500;
    let allRows = [];
    let from = 0;
    while (true) {
      const { data, error } = await buildQuery(from, from + pageSize - 1);
      if (error) throw error;
      allRows = allRows.concat(data || []);
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }
    return allRows;
  }

  async function getPatientDirectory() {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    const data = await fetchAllRows((from, to) => sb
      .rpc('get_patient_directory')
      .range(from, to));

    const byPhone = {};
    const blankPhoneRows = [];
    (data || []).forEach((row) => {
      const phone = (row.phone || '').trim();
      if (!phone) { blankPhoneRows.push(row); return; }
      (byPhone[phone] = byPhone[phone] || []).push(row);
    });

    const directory = [];
    function addEntry(phone, rows) {
      const visited = rows.filter((r) => ['waiting', 'in_consult', 'done'].includes(r.status));
      if (visited.length === 0) return;
      const latest = rows[0];
      const visitDates = visited.map((r) => r.token_date).sort();
      directory.push({
        phone,
        name: latest.name,
        age: latest.age,
        gender: latest.gender,
        address: latest.address,
        totalVisits: visited.length,
        firstVisitDate: visitDates[0],
        lastVisitDate: visitDates[visitDates.length - 1],
        doctorIds: Array.from(new Set(visited.map((r) => r.doctor_id))),
      });
    }
    Object.entries(byPhone).forEach(([phone, rows]) => addEntry(phone, rows));
    blankPhoneRows.forEach((row) => addEntry('', [row]));

    return directory;
  }

  async function checkFollowUpEligibility({ doctorId, phone, visitDate }) {
    const clinicId = await ensureClinicContext();
    const cleanPhone = (phone || '').trim();
    if (!clinicId || !cleanPhone || !doctorId || !visitDate) return null;

    const clinic = await getClinic();
    const bufferDays = clinic ? Number(clinic.follow_up_buffer_days) || 0 : 0;
    if (bufferDays <= 0) return null;

    const { data, error } = await sb
      .from('patients')
      .select('token_date')
      .eq('clinic_id', clinicId)
      .eq('doctor_id', doctorId)
      .eq('phone', cleanPhone)
      .eq('status', 'done')
      .order('token_date', { ascending: false })
      .limit(1);
    if (error) throw error;
    if (!data || data.length === 0) return null;

    const lastVisitDate = data[0].token_date;
    const [ly, lm, ld] = lastVisitDate.split('-').map(Number);
    const [vy, vm, vd] = visitDate.split('-').map(Number);
    const diffDays = Math.round((new Date(vy, vm - 1, vd) - new Date(ly, lm - 1, ld)) / 86400000);

    return {
      eligible: diffDays >= 0 && diffDays <= bufferDays,
      lastVisitDate,
      diffDays,
      bufferDays,
    };
  }

  // opts.strict: the "which visit / which invoice is this" part rethrows
  // its errors instead of swallowing them -- the submit path must not
  // silently fall back to "no visit, no invoice" and create a duplicate
  // bill. The typing-time autofill leaves it off (a failed lookup there
  // just means nothing gets prefilled). opts.name: when several patients
  // share one phone on that day (family), prefer the one with this name.
  async function getBillingPatientLookup(phone, dateStr, opts) {
    const strict = !!(opts && opts.strict);
    const wantedName = ((opts && opts.name) || '').trim().toLowerCase();
    const clinicId = await ensureClinicContext();
    const cleanPhone = (phone || '').trim();
    if (!clinicId || !cleanPhone) return null;

    let patient = null;
    try {
      const { data, error } = await sb.from('patients').select('name, gender, address, age')
        .eq('clinic_id', clinicId).eq('phone', cleanPhone)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      patient = data;
    } catch (e) { }

    let invoice = null;
    try {
      const { data, error } = await sb.from('invoices').select('patient_name, patient_address, patient_age, patient_gender')
        .eq('clinic_id', clinicId).eq('patient_phone', cleanPhone).eq('invoice_type', 'consultation')
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      invoice = data;
    } catch (e) { }

    let todayDoctorId = null;
    let todayPatientId = null;
    let todayPatientName = null;
    let todayVisitDate = null;
    let todayFeeType = null;
    let todayInvoiceId = null;
    let todayPaymentMode = null;
    let todayAmountReceived = null;
    let mostRecentDoctorId = null;
    let mostRecentFeeType = null;
    let mostRecentVisitDate = null;
    try {
      const targetDateStr = dateStr || todayDateStr();
      const { data: todayRows, error: patientErr } = await sb.from('patients')
        .select('id, doctor_id, name')
        .eq('clinic_id', clinicId).eq('phone', cleanPhone).eq('token_date', targetDateStr)
        .order('created_at', { ascending: false }).limit(10);
      if (patientErr) throw patientErr;
      // A typed name that matches nobody must not adopt another family member's visit and bill.
      const todayPatient = (todayRows || []).find((r) => wantedName && (r.name || '').trim().toLowerCase() === wantedName)
        || (wantedName ? null : (todayRows && todayRows[0]))
        || null;
      if (todayPatient) {
        todayDoctorId = todayPatient.doctor_id;
        todayPatientId = todayPatient.id;
        todayPatientName = todayPatient.name || '';
        const { data: todayInvoice, error: invoiceErr } = await sb.from('invoices')
          .select('id, fee_type, payment_mode, amount_received')
          .eq('clinic_id', clinicId).eq('patient_id', todayPatient.id).eq('invoice_type', 'consultation')
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (invoiceErr) throw invoiceErr;
        if (todayInvoice) {
          todayFeeType = todayInvoice.fee_type;
          todayInvoiceId = todayInvoice.id;
          todayPaymentMode = todayInvoice.payment_mode;
          todayAmountReceived = todayInvoice.amount_received;
        }
      } else {
        let unbilledVisit = null;
        try {
          const { data: candidates, error: candErr } = await sb.from('patients')
            .select('id, doctor_id, token_date, name')
            .eq('clinic_id', clinicId).eq('phone', cleanPhone)
            .in('status', ['waiting', 'in_consult', 'done'])
            .order('token_date', { ascending: false })
            .limit(5);
          if (candErr) throw candErr;
          if (candidates && candidates.length) {
            const candidateIds = candidates.map((c) => c.id);
            const { data: existingInvoices, error: invErr } = await sb.from('invoices')
              .select('patient_id')
              .in('patient_id', candidateIds).eq('invoice_type', 'consultation');
            if (invErr) throw invErr;
            const billedIds = new Set((existingInvoices || []).map((i) => i.patient_id));
            unbilledVisit = candidates.find((c) => !billedIds.has(c.id)
              && (!wantedName || (c.name || '').trim().toLowerCase() === wantedName)) || null;
          }
        } catch (e) { if (strict) throw e; }

        if (unbilledVisit) {
          todayDoctorId = unbilledVisit.doctor_id;
          todayPatientId = unbilledVisit.id;
          todayVisitDate = unbilledVisit.token_date;
        } else {
          const { data: recentPatient, error: recentErr } = await sb.from('patients')
            .select('id, doctor_id, token_date')
            .eq('clinic_id', clinicId).eq('phone', cleanPhone)
            .order('token_date', { ascending: false }).limit(1).maybeSingle();
          if (recentErr) throw recentErr;
          if (recentPatient) {
            mostRecentDoctorId = recentPatient.doctor_id;
            mostRecentVisitDate = recentPatient.token_date;
            const { data: recentInvoice, error: recentInvErr } = await sb.from('invoices')
              .select('fee_type')
              .eq('clinic_id', clinicId).eq('patient_id', recentPatient.id).eq('invoice_type', 'consultation')
              .order('created_at', { ascending: false }).limit(1).maybeSingle();
            if (recentInvErr) throw recentInvErr;
            mostRecentFeeType = recentInvoice ? recentInvoice.fee_type : null;
          }
        }
      }
    } catch (e) { if (strict) throw e; }

    if (!patient && !invoice && !todayDoctorId && !mostRecentDoctorId) return null;
    return {
      name: (patient && patient.name) || (invoice && invoice.patient_name) || '',
      address: (patient && patient.address) || (invoice && invoice.patient_address) || '',
      gender: (patient && patient.gender) || (invoice && invoice.patient_gender) || '',
      // ?? not ||, so an infant aged 0 isn't treated as "no age".
      age: (patient ? patient.age : null) ?? (invoice ? invoice.patient_age : null) ?? null,
      mostRecentDoctorId,
      mostRecentFeeType,
      mostRecentVisitDate,
      todayDoctorId,
      todayPatientId,
      todayPatientName,
      todayVisitDate,
      todayFeeType,
      todayInvoiceId,
      todayPaymentMode,
      todayAmountReceived,
    };
  }

  function normalizeInvoice(row) {
    return {
      id: row.id,
      invoiceNumber: row.invoice_number,
      invoiceType: row.invoice_type || 'consultation',
      doctorId: row.doctor_id,
      patientId: row.patient_id,
      feeType: row.fee_type,
      amount: Number(row.amount),
      patientName: row.patient_name,
      patientPhone: row.patient_phone,
      patientAddress: row.patient_address,
      patientAge: row.patient_age,
      patientGender: row.patient_gender,
      paymentMode: row.payment_mode,
      amountReceived: row.amount_received == null ? null : Number(row.amount_received),
      createdAt: row.created_at,
      invoiceDate: row.invoice_date,
    };
  }

  async function hasAppointmentOnDate(phone, dateStr) {
    const clinicId = await ensureClinicContext();
    if (!clinicId || !phone) return false;
    const { data, error } = await sb.from('patients').select('id')
      .eq('clinic_id', clinicId)
      .eq('phone', phone)
      .eq('token_date', dateStr)
      .limit(1);
    if (error) throw error;
    return data.length > 0;
  }

  async function createInvoice({ doctorId, feeType, patientName, patientPhone, patientAddress, patientAge, patientGender, paymentMode, amountReceived, invoiceDate, patientId }) {
    const { data, error } = await sb.rpc('create_invoice', {
      p_doctor_id: doctorId,
      p_fee_type: feeType,
      p_patient_name: patientName,
      p_patient_phone: patientPhone || '',
      p_patient_address: patientAddress || '',
      p_patient_age: (patientAge === undefined || patientAge === '') ? null : patientAge,
      p_patient_gender: patientGender || '',
      p_payment_mode: paymentMode || 'cash',
      p_amount_received: amountReceived == null ? null : Number(amountReceived),
      p_invoice_date: invoiceDate || todayDateStr(),
      p_patient_id: patientId || null,
    });
    if (error) throw error;
    return normalizeInvoice(data);
  }

  async function getInvoicesForDate(dateStr) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    const data = await fetchAllRows((from, to) => sb.from('invoices').select('*')
      .eq('clinic_id', clinicId)
      .eq('invoice_date', dateStr)
      .eq('invoice_type', 'consultation')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to));
    return data.map(normalizeInvoice);
  }

  async function getTodayInvoices() {
    return getInvoicesForDate(todayDateStr());
  }

  async function getInvoicesForDateRange(startDateStr, endDateStr) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    const data = await fetchAllRows((from, to) => sb.from('invoices').select('*')
      .eq('clinic_id', clinicId)
      .gte('invoice_date', startDateStr)
      .lte('invoice_date', endDateStr)
      .eq('invoice_type', 'consultation')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to));
    return data.map(normalizeInvoice);
  }

  async function getOutstandingInvoices() {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    // Server side filter (migration 113); falls back to reading every bill if it is not there yet.
    const { data: outstanding, error: rpcError } = await sb.rpc('get_outstanding_invoices');
    if (!rpcError && Array.isArray(outstanding)) return outstanding.map(normalizeInvoice);
    const data = await fetchAllRows((from, to) => sb.from('invoices').select('*')
      .eq('clinic_id', clinicId)
      .eq('invoice_type', 'consultation')
      .order('invoice_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to));
    return data.map(normalizeInvoice).filter((inv) => inv.amount > inv.amountReceived);
  }

  async function getPatientsInRange(startDateStr, endDateStr, doctorId) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    const data = await fetchAllRows((from, to) => {
      let query = sb.from('patients').select('*')
        .eq('clinic_id', clinicId)
        .gte('token_date', startDateStr)
        .lte('token_date', endDateStr);
      if (doctorId) query = query.eq('doctor_id', doctorId);
      return query.order('token_date', { ascending: true }).order('id', { ascending: true }).range(from, to);
    });
    return data.map(normalizePatient);
  }

  async function getNoShowsForDate(dateStr) {
    return getNoShowsForDateRange(dateStr, dateStr);
  }
  async function getNoShowsForDateRange(startDateStr, endDateStr) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    const data = await fetchAllRows((from, to) => sb.from('patients').select('*')
      .eq('clinic_id', clinicId)
      .eq('status', 'no_show')
      .gte('token_date', startDateStr)
      .lte('token_date', endDateStr)
      .order('token_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to));
    return data.map(normalizePatient);
  }

  async function getInvoiceById(invoiceId) {
    const { data, error } = await sb.from('invoices').select('*').eq('id', invoiceId).maybeSingle();
    if (error) throw error;
    return data ? normalizeInvoice(data) : null;
  }

  async function getBillingAudit() {
    const { data, error } = await sb.rpc('get_billing_audit');
    if (error) throw error;
    return {
      totalInvoices: data.totalInvoices || 0,
      minInvoiceNumber: data.minInvoiceNumber,
      maxInvoiceNumber: data.maxInvoiceNumber,
      unbilledPatients: (data.unbilledPatients || []).map((p) => ({
        id: p.id, name: p.name, phone: p.phone, tokenDate: p.tokenDate, status: p.status, doctorId: p.doctorId,
      })),
    };
  }

  async function updateInvoicePayment({ invoiceId, feeType, paymentMode, amountReceived }) {
    const { data, error } = await sb.rpc('update_invoice_payment', {
      p_invoice_id: invoiceId,
      p_fee_type: feeType,
      p_payment_mode: paymentMode,
      p_amount_received: amountReceived == null ? null : Number(amountReceived),
    });
    if (error) throw error;
    return normalizeInvoice(data);
  }

  function queueLinkFor(patientId) {
    const dir = window.location.href.replace(/[^/]*$/, '');
    return `${dir}queue.html?id=${patientId}`;
  }

  // ---- WhatsApp booking confirmation (Clinic Settings > Patient messages) ----
  // Nothing is sent by the app: it builds a message and a wa.me link, and the
  // receptionist presses Send in the clinic's own WhatsApp. Hindi first, then
  // English, with the queue link written once at the end.
  const HI_WEEKDAYS = ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'];
  const HI_MONTHS = ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'];
  const EN_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function isWhatsAppConfirmEnabled(clinic) {
    return !!clinic && clinic.whatsapp_confirm_enabled === true;
  }

  // Digits for a wa.me link: a 10 digit Indian number gets 91 in front; a
  // number already typed with a country code is left as it is.
  function whatsappPhoneDigits(phone) {
    const digits = String(phone || '').replace(/\D/g, '').replace(/^0+/, '');
    if (digits.length === 10) return '91' + digits;
    return digits.length >= 11 && digits.length <= 15 ? digits : null;
  }

  function hindiTimeLabel(minutes) {
    const h24 = Math.floor(minutes / 60);
    const mm = String(minutes % 60).padStart(2, '0');
    const period = h24 < 5 ? 'रात' : h24 < 12 ? 'सुबह' : h24 < 16 ? 'दोपहर' : h24 < 20 ? 'शाम' : 'रात';
    return `${period} ${h24 % 12 || 12}:${mm}`;
  }

  // patient: { id, name, phone, type, bookedDate, bookedTime }. tokenLabel is
  // the token exactly as the patient will see it ("#7", "W2").
  function buildWhatsAppMessage({ patient, clinic, doctor, tokenLabel }) {
    const plainDoctor = String((doctor && doctor.name) || '').replace(/^dr\.?\s+/i, '').trim();
    const link = queueLinkFor(patient.id);
    const hi = [`नमस्ते ${patient.name},`];
    const en = [`Hello ${patient.name},`];

    if (patient.type === 'appointment') {
      hi.push(`${clinic.name} में आपकी बुकिंग पक्की हो गई है।`);
      en.push(`Your booking at ${clinic.name} is confirmed.`);
    } else {
      hi.push(`आप ${clinic.name} की कतार में जुड़ गए हैं।`);
      en.push(`You are in the queue at ${clinic.name}.`);
    }
    if (plainDoctor) {
      hi.push(`डॉक्टर: डॉ. ${plainDoctor}`);
      en.push(`Doctor: Dr. ${plainDoctor}`);
    }
    if (tokenLabel) {
      hi.push(`टोकन नंबर: ${tokenLabel}`);
      en.push(`Token number: ${tokenLabel}`);
    }
    if (patient.type === 'appointment' && patient.bookedDate) {
      const [y, m, d] = patient.bookedDate.split('-').map(Number);
      const day = new Date(y, m - 1, d);
      hi.push(`तारीख: ${HI_WEEKDAYS[day.getDay()]}, ${d} ${HI_MONTHS[m - 1]}`);
      en.push(`Date: ${EN_WEEKDAYS[day.getDay()]}, ${d} ${EN_MONTHS[m - 1]}`);
      if (patient.bookedTime) {
        const minutes = parseTime(patient.bookedTime);
        hi.push(`समय: ${hindiTimeLabel(minutes)}`);
        en.push(`Time: ${formatTime(minutes)}`);
      }
      hi.push('कृपया अपने समय से 15 मिनट पहले पहुँचें।');
      en.push('Please arrive 15 minutes before your appointment time.');
    }

    return [
      hi.join('\n'),
      en.join('\n'),
      'आप कतार की स्थिति यहाँ देख सकते हैं / You can follow the queue here:\n' + link,
    ].join('\n\n');
  }

  // Returns null when the number can't be opened in WhatsApp.
  function whatsappUrlFor({ patient, clinic, doctor, tokenLabel }) {
    const digits = whatsappPhoneDigits(patient.phone);
    if (!digits) return null;
    const text = buildWhatsAppMessage({ patient, clinic, doctor, tokenLabel });
    return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
  }

  async function queueBookingNotification({ patientId, phone, doctorId, kind, bookedDate, bookedTime, tokenNumber }) {
    try {
      const clinicId = await ensureClinicContext();
      const clinic = await getClinic();
      // WhatsApp confirmations replace the pending text message queue for
      // this clinic, so a message provider connected later can't double up.
      if (isWhatsAppConfirmEnabled(clinic)) return null;
      const doctor = await getDoctor(doctorId);
      const tokenDisplay = tokenNumber ? (tokenNumber > 100000 ? 'W' + (tokenNumber - 100000) : '#' + tokenNumber) : null;
      const tokenLine = tokenDisplay ? ` Your token number is ${tokenDisplay}.` : '';
      const link = tokenNumber ? queueLinkFor(patientId) : '';
      const doctorLine = doctor.specialty ? `${doctor.name} (${doctor.specialty})` : doctor.name;

      let message;
      if (kind === 'appointment') {
        const dateLabel = formatDateLabel(bookedDate);
        const timeLabel = formatTime(parseTime(bookedTime));
        const isFuture = bookedDate && bookedDate > todayDateStr();
        const queuePart = !link ? ''
          : isFuture
            ? ` This link will show your live queue position starting on the morning of ${dateLabel} — checking it before then won't show anything yet: ${link}`
            : ` See the current token being served and the next 5 in line, so you know when to leave home: ${link}`;
        message = `Hi! Your appointment with ${doctorLine} at ${clinic.name} is ${dateLabel} at ${timeLabel}.${tokenLine}${queuePart} – ${clinic.name}`;
      } else {
        const queueLine = link ? ` See the current token being served and the next 5 in line, so you know when to leave home: ${link}` : '';
        message = `Hi! You're in the queue for ${doctorLine} at ${clinic.name}.${tokenLine}` +
          (queueLine || ' We\'ll keep you posted on your turn.') +
          ` – ${clinic.name}`;
      }

      const { error } = await sb.from('notifications').insert({
        clinic_id: clinicId, patient_id: patientId, phone, message,
      });
      if (error) throw error;
      return message;
    } catch (err) {
      console.warn('Could not queue patient notification:', err);
      return null;
    }
  }

  async function getQueueStatus(patientId) {
    const { data, error } = await sb.rpc('get_queue_status', { p_patient_id: patientId });
    if (error) throw error;
    return data;
  }

  async function submitProductFeedback(patientId, rating, feedbackText) {
    const { data, error } = await sb.rpc('submit_product_feedback', {
      p_patient_id: patientId,
      p_rating: rating,
      p_feedback_text: feedbackText || null,
    });
    if (error) throw error;
    return data;
  }

  // Visit feedback (rating the clinic/doctor, distinct from
  // submitProductFeedback above which rates ClinVision itself).
  // routedToReview is true only on the call fired by the "Share on
  // Google" click -- the RPC only ever ORs that flag forward, so
  // calling this again later (e.g. to save a comment typed after
  // already sharing) can't un-mark it.
  // feedbackText: leave it out (undefined) to keep whatever comment is
  // already saved; pass a string, including '', to replace it ('' clears).
  async function submitVisitFeedback({ patientId, rating, feedbackText, routedToReview }) {
    const { data, error } = await sb.rpc('submit_visit_feedback', {
      p_patient_id: patientId,
      p_rating: rating,
      p_feedback_text: feedbackText === undefined ? null : feedbackText,
      p_routed_to_review: !!routedToReview,
    });
    if (error) throw error;
    return data;
  }

  // For the clinic's own feedback list (feedback.html) -- RLS already
  // scopes this to the caller's own clinic, same as every other direct
  // table read in this file. Embeds the patient's name/phone via the
  // foreign key relationship rather than a second round trip.
  async function getClinicFeedback() {
    // Paged: one request is capped at 1000 rows, which would silently cut off older feedback.
    const data = await fetchAllRows((from, to) => sb
      .from('visit_feedback')
      .select('id, rating, feedback_text, routed_to_review, submitted_at, patients(name, phone, doctor_id)')
      .order('submitted_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to));
    return (data || []).map((row) => ({
      id: row.id,
      rating: row.rating,
      feedbackText: row.feedback_text || '',
      routedToReview: row.routed_to_review,
      submittedAt: row.submitted_at,
      patientName: row.patients ? row.patients.name : '',
      patientPhone: row.patients ? row.patients.phone : '',
      doctorId: row.patients ? row.patients.doctor_id : null,
    }));
  }

  async function callNextPatient(doctorId) {
    const today = todayDateStr();
    const [doctor, mine] = await Promise.all([
      getDoctor(doctorId),
      fetchPatientsForDoctorAndDate(doctorId, today),
    ]);
    const current = mine.find((p) => p.status === 'in_consult');
    if (current) {
      const doneAt = new Date();
      const updatePayload = { status: 'done', done_at: doneAt.toISOString() };
      if (current.calledAt) {
        updatePayload.consultation_duration_seconds = Math.max(0, Math.round((doneAt.getTime() - new Date(current.calledAt).getTime()) / 1000));
      }
      const { data: finished, error } = await sb.from('patients').update(updatePayload).eq('id', current.id).eq('status', 'in_consult').select('id');
      if (error) throw error;
      if (!finished || !finished.length) throw new Error('The queue changed on another screen. Please check it and try again.');
    }
    const waiting = mine.filter((p) => p.status === 'waiting').sort((a, b) => compareQueueOrder(a, b, doctor));
    if (waiting.length === 0) return { called: false };
    const { data: called, error } = await sb.from('patients').update({ status: 'in_consult', called_at: new Date().toISOString() }).eq('id', waiting[0].id).eq('status', 'waiting').select('id');
    if (error) throw error;
    if (!called || !called.length) throw new Error('The queue changed on another screen. Please check it and try again.');
    return { called: true };
  }

  async function finishCurrentPatient(doctorId, expectedPatientId) {
    const today = todayDateStr();
    const mine = await fetchPatientsForDoctorAndDate(doctorId, today);
    const current = mine.find((p) => p.status === 'in_consult');
    // When the caller names the patient it means to finish and someone else is in now, do nothing.
    if (expectedPatientId && (!current || current.id !== expectedPatientId)) {
      throw new Error('That visit was already finished on another screen.');
    }
    if (current) {
      const doneAt = new Date();
      const updatePayload = { status: 'done', done_at: doneAt.toISOString() };
      if (current.calledAt) {
        updatePayload.consultation_duration_seconds = Math.max(0, Math.round((doneAt.getTime() - new Date(current.calledAt).getTime()) / 1000));
      }
      const { data: finished, error } = await sb.from('patients').update(updatePayload).eq('id', current.id).eq('status', 'in_consult').select('id');
      if (error) throw error;
      if (!finished || !finished.length) throw new Error('That visit was already finished on another screen.');
    }
  }

  async function setDoctorStatus(doctorId, status, delayMins, note) {
    const { error } = await sb.from('doctors').update({
      status,
      delay_mins: Number(delayMins) || 0,
      status_note: note || '',
      status_updated_at: new Date().toISOString(),
    }).eq('id', doctorId);
    if (error) throw error;
  }

  async function countActiveAtSlot(doctorId, dateStr, timeStr, excludePatientId) {
    const clinicId = await ensureClinicContext();
    const clinic = await getClinic();
    const targetBucket = bucketStartMinutes(timeStr, clinic.slot_interval_mins);
    const { data, error } = await sb
      .from('patients')
      .select('id, booked_time')
      .eq('clinic_id', clinicId)
      .eq('doctor_id', doctorId)
      .eq('booked_date', dateStr)
      .not('booked_time', 'is', null)
      .in('status', ['booked', 'waiting', 'in_consult']);
    if (error) throw error;
    return data.filter((p) =>
      p.id !== excludePatientId &&
      bucketStartMinutes(p.booked_time.slice(0, 5), clinic.slot_interval_mins) === targetBucket
    ).length;
  }

  // The doctor's day is read once and counted in memory (this used to be one
  // query per bucket, up to 48 in a row). Stops at closing time / midnight,
  // so it never suggests an out-of-hours slot or wraps past 23:59 back to
  // "00:00"; returns null when nothing later that day has room.
  async function findNextAvailableSlot(doctorId, dateStr, fromTimeStr) {
    const clinicId = await ensureClinicContext();
    const clinic = await getClinic();
    const interval = clinic.slot_interval_mins;
    const { data, error } = await sb
      .from('patients')
      .select('booked_time')
      .eq('clinic_id', clinicId)
      .eq('doctor_id', doctorId)
      .eq('booked_date', dateStr)
      .not('booked_time', 'is', null)
      .in('status', ['booked', 'waiting', 'in_consult']);
    if (error) throw error;
    const counts = {};
    data.forEach((p) => {
      const b = bucketStartMinutes(p.booked_time.slice(0, 5), interval);
      counts[b] = (counts[b] || 0) + 1;
    });
    const endMinutes = clinic.closing_time ? parseTime(clinic.closing_time.slice(0, 5)) : 24 * 60;
    for (let bucket = bucketStartMinutes(fromTimeStr, interval); bucket < endMinutes; bucket += interval) {
      if ((counts[bucket] || 0) < clinic.slot_capacity) return formatHHMM(bucket);
    }
    return null;
  }

  async function getSlotAvailability(doctorId, dateStr, timeStr) {
    if (!doctorId || !dateStr || !timeStr) return null;
    const clinic = await getClinic();
    const count = await countActiveAtSlot(doctorId, dateStr, timeStr);
    const isFull = count >= clinic.slot_capacity;
    const bucketStart = bucketStartMinutes(timeStr, clinic.slot_interval_mins);
    return {
      count,
      capacity: clinic.slot_capacity,
      isFull,
      suggestion: isFull ? await findNextAvailableSlot(doctorId, dateStr, timeStr) : null,
      windowStart: formatHHMM(bucketStart),
      windowEnd: formatHHMM(bucketStart + clinic.slot_interval_mins),
    };
  }

  async function getDaySlotSchedule(doctorId, dateStr) {
    const clinicId = await ensureClinicContext();
    const { data, error } = await sb
      .from('patients')
      .select('booked_time')
      .eq('clinic_id', clinicId)
      .eq('doctor_id', doctorId)
      .eq('token_date', dateStr)
      .order('booked_time');
    if (error) throw error;
    return data;
  }

  function slotScheduleDialog({ doctorName, dateLabel, openMin, closeMin, intervalMins, rows, isToday }) {
    return new Promise((resolve) => {
      const nowMin = isToday ? (new Date().getHours() * 60 + new Date().getMinutes()) : null;
      const buckets = [];
      for (let start = openMin; start < closeMin; start += intervalMins) {
        buckets.push({ start, end: Math.min(start + intervalMins, closeMin), count: 0 });
      }
      let noTimeCount = 0;
      let outsideHoursCount = 0;
      rows.forEach((r) => {
        if (!r.booked_time) { noTimeCount += 1; return; }
        const mins = parseTime(r.booked_time.slice(0, 5));
        // A booking before opening or after closing has no row in the grid;
        // it used to be added to the LAST bucket, inflating that hour.
        const bucket = buckets.find((b) => mins >= b.start && mins < b.end);
        if (bucket) bucket.count += 1; else outsideHoursCount += 1;
      });
      const outsideHoursHtml = outsideHoursCount > 0
        ? `<p class="panel-note" style="margin:4px 0 14px;">+ ${outsideHoursCount} booking${outsideHoursCount === 1 ? '' : 's'} outside clinic hours, not shown in the grid below.</p>`
        : '';
      const rowsHtml = buckets.map((b, i) => {
        const isPast = nowMin != null && b.end <= nowMin;
        const isCurrent = nowMin != null && nowMin >= b.start && nowMin < b.end;
        return `
        <tr data-bucket-idx="${i}" ${isPast ? 'style="color:var(--grey-500);"' : ''}>
          <td style="white-space:nowrap;">${formatTime(b.start)}–${formatTime(b.end)}${isCurrent ? ' <span class="badge badge-in-consult" style="font-size:10px;">now</span>' : ''}</td>
          <td style="text-align:center;">${b.count}</td>
        </tr>
      `;
      }).join('');

      const noTimeHtml = noTimeCount > 0
        ? `<p class="panel-note" style="margin:4px 0 14px;">+ ${noTimeCount} walk-in${noTimeCount === 1 ? '' : 's'} with no preferred time today, not shown in the grid below.</p>`
        : '';

      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal-card" role="dialog" aria-modal="true">
          <h2 class="modal-title">${escapeHtml(doctorName)}'s schedule — ${escapeHtml(dateLabel)}</h2>
          ${noTimeHtml}
          ${outsideHoursHtml}
          <div id="scheduleGridScroll" style="max-height:45vh;overflow-y:auto;">
            <table class="qtable">
              <thead><tr><th>Time</th><th style="text-align:center;">Count</th></tr></thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn-sm primary" id="modalCloseBtn">Close</button>
          </div>
        </div>
      `;
      document.body.appendChild(backdrop);

      if (nowMin != null) {
        const nowRow = Array.from(backdrop.querySelectorAll('tr[data-bucket-idx]')).find((_, i) => {
          const b = buckets[i];
          return nowMin >= b.start && nowMin < b.end;
        });
        if (nowRow) nowRow.scrollIntoView({ block: 'center' });
      }

      function cleanup() {
        backdrop.remove();
        document.removeEventListener('keydown', onKeydown);
        resolve();
      }
      function onKeydown(e) {
        if (e.key === 'Escape') cleanup();
      }
      document.addEventListener('keydown', onKeydown);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(); });
      backdrop.querySelector('#modalCloseBtn').addEventListener('click', cleanup);
      backdrop.querySelector('#modalCloseBtn').focus();
    });
  }

  function statBreakdownDialog({ title, columns, rows, rowHrefs, viewAllHref }) {
    return new Promise((resolve) => {
      const headHtml = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
      const rowsHtml = rows.length
        ? rows.map((r, i) => {
            const href = rowHrefs && rowHrefs[i];
            const cellsHtml = r.map((cell) => `<td>${escapeHtml(String(cell))}</td>`).join('');
            return href
              ? `<tr class="breakdown-row-link" data-href="${escapeHtml(href)}">${cellsHtml}</tr>`
              : `<tr>${cellsHtml}</tr>`;
          }).join('')
        : `<tr><td colspan="${columns.length}" class="empty-state">Nothing to show right now.</td></tr>`;

      const viewAllHtml = viewAllHref
        ? `<a href="${escapeHtml(viewAllHref)}" style="display:block;margin-bottom:10px;color:var(--accent);font-weight:600;">View every patient behind this number</a>`
        : '';

      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal-card" role="dialog" aria-modal="true">
          <h2 class="modal-title">${escapeHtml(title)}</h2>
          ${viewAllHtml}
          <div style="max-height:55vh;overflow-y:auto;">
            <table class="qtable">
              <thead><tr>${headHtml}</tr></thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn-sm primary" id="modalCloseBtn">Close</button>
          </div>
        </div>
      `;
      document.body.appendChild(backdrop);

      if (rowHrefs) {
        backdrop.querySelectorAll('tr.breakdown-row-link').forEach((tr) => {
          tr.addEventListener('click', () => { window.location.href = tr.getAttribute('data-href'); });
        });
      }

      function cleanup() {
        backdrop.remove();
        document.removeEventListener('keydown', onKeydown);
        resolve();
      }
      function onKeydown(e) {
        if (e.key === 'Escape') cleanup();
      }
      document.addEventListener('keydown', onKeydown);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(); });
      backdrop.querySelector('#modalCloseBtn').addEventListener('click', cleanup);
      backdrop.querySelector('#modalCloseBtn').focus();
    });
  }

  async function getDailySummary(dateStr, doctorId) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return { totalAppointments: 0, totalWalkIns: 0, totalBookedToday: 0, footfallSoFar: 0, noShowCount: 0, waitingNow: 0, doneCount: 0, inConsultCount: 0, perDoctor: [] };
    const targetDate = dateStr || todayDateStr();
    const [clinic, doctors, { data, error }] = await Promise.all([
      getClinic(),
      getDoctors(),
      sb.from('patients').select('*').eq('clinic_id', clinicId).eq('token_date', targetDate),
    ]);
    if (error) throw error;
    const doctorById = Object.fromEntries(doctors.map((d) => [d.id, d]));
    const allToday = data.map(normalizePatient);
    let todays = allToday;
    if (doctorId) todays = todays.filter((p) => p.doctorId === doctorId);

    const perDoctor = doctors.map((d) => {
      const mine = allToday.filter((p) => p.doctorId === d.id);
      const mineAppointments = mine.filter((p) => p.type === 'appointment').length;
      const mineWalkIns = mine.filter((p) => p.type === 'walkin').length;
      return {
        doctorId: d.id,
        doctorName: d.name,
        totalAppointments: mineAppointments,
        totalWalkIns: mineWalkIns,
        totalBookedToday: mineAppointments + mineWalkIns,
        waiting: mine.filter((p) => p.status === 'waiting').length,
        inConsult: mine.filter((p) => p.status === 'in_consult').length,
        done: mine.filter((p) => p.status === 'done').length,
        noShow: mine.filter((p) => p.status === 'no_show').length,
        priorityWaiting: mine.filter((p) => p.status === 'waiting' && p.isPriority).length,
        footfall: mine.filter((p) => ['waiting', 'in_consult', 'done'].indexOf(p.status) !== -1).length,
      };
    });

    const totalAppointments = todays.filter((p) => p.type === 'appointment').length;
    const totalWalkIns = todays.filter((p) => p.type === 'walkin').length;
    return {
      totalAppointments,
      totalWalkIns,
      totalBookedToday: totalAppointments + totalWalkIns,
      footfallSoFar: todays.filter((p) => ['waiting', 'in_consult', 'done'].indexOf(p.status) !== -1).length,
      noShowCount: todays.filter((p) => p.status === 'no_show').length,
      waitingNow: todays.filter((p) => p.status === 'waiting').length,
      doneCount: todays.filter((p) => p.status === 'done').length,
      inConsultCount: todays.filter((p) => p.status === 'in_consult').length,
      perDoctor,
    };
  }

  async function closeDayNoShows() {
    const clinicId = await ensureClinicContext();
    const { error } = await sb
      .from('patients')
      .update({ status: 'no_show' })
      .eq('clinic_id', clinicId)
      .eq('status', 'booked')
      .eq('booked_date', todayDateStr());
    if (error) throw error;
    const { error: clinicError } = await sb
      .from('clinics')
      .update({ last_closed_date: todayDateStr(), closed_at: new Date().toISOString() })
      .eq('id', clinicId);
    if (clinicError) throw clinicError;
    currentClinic = null;
  }

  // How many of today's patients the close button would (or did) turn into
  // no-shows: same clinic + booked_date filter as closeDayNoShows, so the
  // number on screen is exactly what the button acts on.
  async function getTodayCloseoutCounts() {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return { stillBooked: 0, noShows: 0 };
    const today = todayDateStr();
    const count = async (status) => {
      const { count: n, error } = await sb
        .from('patients')
        .select('id', { count: 'exact', head: true })
        .eq('clinic_id', clinicId)
        .eq('status', status)
        .eq('booked_date', today);
      if (error) throw error;
      return n || 0;
    };
    const [stillBooked, noShows] = await Promise.all([count('booked'), count('no_show')]);
    return { stillBooked, noShows };
  }

  async function reopenDay() {
    const clinicId = await ensureClinicContext();
    const { error } = await sb
      .from('clinics')
      .update({ last_closed_date: null, closed_at: null })
      .eq('id', clinicId);
    if (error) throw error;
    currentClinic = null;
  }

  async function closeDoctorDay(doctorId) {
    const { error } = await sb
      .from('doctors')
      .update({ day_closed_at: new Date().toISOString() })
      .eq('id', doctorId);
    if (error) throw error;
  }

  async function reopenDoctorDay(doctorId) {
    const { error } = await sb
      .from('doctors')
      .update({
        day_closed_at: null,
        status: 'on_time',
        delay_mins: 0,
        status_note: '',
        status_updated_at: new Date().toISOString(),
      })
      .eq('id', doctorId);
    if (error) throw error;
  }

  const STALE_AUTO_NOTE_RE = /^(on a break for about .+\.|running about .+ behind\.)$/i;
  function isRealStatusReason(note) {
    return !!note && !STALE_AUTO_NOTE_RE.test(note.trim());
  }

  function isDoctorClosedToday(doctor) {
    if (!doctor || !doctor.dayClosedAt) return false;
    return IST_DATE_FORMAT.format(new Date(doctor.dayClosedAt)) === todayDateStr();
  }

  const CLOSED_RESET_HOUR = 4;
  function isClosedUntilReset(closedAtIso) {
    if (!closedAtIso) return false;
    const closedAt = new Date(closedAtIso);
    const reset = new Date(closedAt);
    reset.setHours(CLOSED_RESET_HOUR, 0, 0, 0);
    if (reset <= closedAt) reset.setDate(reset.getDate() + 1);
    return Date.now() < reset.getTime();
  }

  function isClinicClosedToday(clinic) {
    return !!clinic && isClosedUntilReset(clinic.closed_at);
  }

  async function signUp(email, password, clinicName, clinicAddress, clinicPhone) {
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { data: { pending_clinic_name: clinicName, pending_clinic_address: clinicAddress || null, pending_clinic_phone: clinicPhone || null } },
    });
    if (error) throw error;
    if (data.session) {
      await finishClinicSetupIfNeeded(data.session);
    }
    return data;
  }

  async function login(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await finishClinicSetupIfNeeded(data.session);
    return true;
  }

  async function logout() {
    await sb.auth.signOut();
    currentClinicId = null;
    currentClinic = null;
    // Per-user caches: the next login on this page must not see the last
    // user's profile or feature flags.
    myProfilePromise = null;
    Object.keys(featureCache).forEach((key) => { delete featureCache[key]; });
  }

  async function isLoggedIn() {
    const { data: { session } } = await sb.auth.getSession();
    return !!session;
  }

  function isSubscriptionActive(clinic) {
    if (!clinic) return true;
    if (clinic.subscription_status === 'active') return true;
    if (clinic.subscription_status === 'trialing') {
      return !clinic.trial_ends_at || new Date(clinic.trial_ends_at) > new Date();
    }
    return false;
  }

  async function requireLogin(loginPagePath) {
    if (!(await isLoggedIn())) {
      window.location.href = loginPagePath || 'login.html';
      return false;
    }
    const clinic = await getClinic();
    if (!isSubscriptionActive(clinic)) {
      window.location.href = 'account-suspended.html';
      return false;
    }
    const profile = await getMyProfile();
    if (!profile || profile.isActive === false) {
      window.location.href = 'account-deactivated.html';
      return false;
    }
    return true;
  }

  async function getCurrentUserEmail() {
    const { data: { session } } = await sb.auth.getSession();
    return session ? session.user.email : null;
  }

  async function changeEmail(newEmail) {
    const { error } = await sb.auth.updateUser({ email: newEmail });
    if (error) throw error;
  }

  async function changePassword(newPassword) {
    const { error } = await sb.auth.updateUser({ password: newPassword });
    if (error) throw error;
  }

  async function requestPasswordReset(email, redirectTo) {
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw error;
  }

  async function completePasswordReset(newPassword) {
    const { error } = await sb.auth.updateUser({ password: newPassword });
    if (error) throw error;
  }

  function normalizeProfile(row) {
    return {
      id: row.id,
      email: row.email,
      phone: row.phone,
      fullName: row.full_name,
      role: row.role,
      isActive: row.is_active,
      doctorId: row.doctor_id,
      createdAt: row.created_at,
    };
  }

  let myProfilePromise = null;
  async function getMyProfile() {
    if (!myProfilePromise) {
      const attempt = (async () => {
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return null;
        const { data, error } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
        if (error) throw error;
        return data ? normalizeProfile(data) : null;
      })();
      myProfilePromise = attempt;
      // Only a real profile stays cached. A failed fetch, or "no session yet",
      // is forgotten so the next call asks again instead of every isAdmin()
      // / requireLogin on the page reusing that one bad result until reload.
      attempt.then((value) => { if (value === null) myProfilePromise = null; }, () => { myProfilePromise = null; });
    }
    return myProfilePromise;
  }

  async function isAdmin() {
    const profile = await getMyProfile();
    return !!profile && profile.role === 'admin' && profile.isActive;
  }

  async function canAccessBilling() {
    const profile = await getMyProfile();
    return !!profile && profile.isActive && (profile.role === 'admin' || profile.role === 'reception');
  }

  async function isDoctor() {
    const profile = await getMyProfile();
    return !!profile && profile.role === 'doctor' && profile.isActive;
  }

  async function isPharmacist() {
    const profile = await getMyProfile();
    return !!profile && profile.role === 'pharmacist' && profile.isActive;
  }

  async function canAccessPharmacy() {
    const profile = await getMyProfile();
    return !!profile && profile.isActive && ['admin', 'reception', 'pharmacist'].includes(profile.role);
  }

  async function getMyDoctorId() {
    const profile = await getMyProfile();
    return profile && profile.role === 'doctor' && profile.isActive ? profile.doctorId : null;
  }

  // Name shown for the signed-in user (top bar, dashboard greeting):
  // "Dr. <name>" for a doctor, else their full name, else their email.
  async function getMyDisplayName() {
    const profile = await getMyProfile();
    const email = await getCurrentUserEmail();
    const withDr = (n) => (/^dr\.?\s/i.test(n) ? n : 'Dr. ' + n);
    if (profile && profile.role === 'doctor' && profile.doctorId) {
      let name = null;
      try {
        const doctor = await getDoctor(profile.doctorId);
        name = (doctor && doctor.name) || null;
      } catch (err) { }
      name = name || (profile.fullName || '').trim() || null;
      if (name) return { text: withDr(name), isEmail: false };
    }
    const fullName = profile && (profile.fullName || '').trim();
    if (fullName) return { text: fullName, isEmail: false };
    return { text: email || '', isEmail: true };
  }

  // Two-letter initials from a person's name, or from an email's local
  // part ("satyam.test@x.in" -> "ST"). A leading "Dr." is ignored.
  function initialsFor(text) {
    const value = (text || '').trim();
    const parts = value.includes('@')
      ? value.split('@')[0].split(/[._-]+/).filter(Boolean)
      : value.replace(/^dr\.?\s+/i, '').split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const first = parts[0][0];
    const second = parts.length > 1 ? parts[parts.length - 1][0] : parts[0][1] || '';
    return (first + second).toUpperCase();
  }

  // Stable index in [0, count) for a string, so the same name always gets
  // the same avatar colour.
  function hashIndex(text, count) {
    let h = 0;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % count;
  }

  async function getTeam() {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    const { data, error } = await sb.from('profiles').select('*').eq('clinic_id', clinicId).order('created_at');
    if (error) throw error;
    return data.map(normalizeProfile);
  }

  async function createStaffAccount({ email, password, fullName, role, doctorId, phone }) {
    const tempClient = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    let userId;
    const signUpResult = await tempClient.auth.signUp({ email, password });
    if (signUpResult.error) {
      // The sign-up is two steps (create the login, then the clinic profile).
      // If an earlier attempt created the login but the profile step failed
      // (a phone already in use, a doctor already linked), the email is now
      // "already registered" and retrying could never finish. Signing in
      // with the same password recovers that half-made login instead of
      // leaving the email permanently burned.
      if (/already registered/i.test(signUpResult.error.message || '')) {
        const signInResult = await tempClient.auth.signInWithPassword({ email, password });
        if (signInResult.error) throw signUpResult.error;
        userId = signInResult.data.user.id;
      } else {
        throw signUpResult.error;
      }
    } else {
      userId = signUpResult.data.user.id;
    }
    const { error: linkError } = await sb.rpc('create_staff_profile', {
      new_user_id: userId,
      staff_email: email,
      staff_full_name: fullName,
      staff_role: role,
      staff_doctor_id: role === 'doctor' ? (doctorId || null) : null,
      staff_phone: phone || null,
    });
    if (linkError) {
      throw new Error(`${linkError.message || 'Could not finish setting up this person.'} Their login was created, so fix that and press Add again with the same email and password.`);
    }
  }

  async function setStaffActive(profileId, isActive) {
    const { error } = await sb.rpc('set_staff_active_cascade', {
      target_profile_id: profileId,
      new_active: isActive,
    });
    if (error) throw error;
  }

  async function updateStaffRole(profileId, role) {
    const { error } = await sb.from('profiles').update({ role }).eq('id', profileId);
    if (error) throw error;
  }

  async function updateStaffName(profileId, fullName) {
    const { error } = await sb.from('profiles').update({ full_name: fullName }).eq('id', profileId);
    if (error) throw error;
  }

  async function updateStaffPhone(profileId, phone) {
    const { error } = await sb.rpc('update_staff_phone', { staff_id: profileId, new_phone: phone || null });
    if (error) throw error;
  }

  async function updateMyPhone(phone) {
    const { error } = await sb.rpc('update_my_phone', { new_phone: phone || null });
    if (error) throw error;
  }

  async function updateStaffDoctorLink(profileId, doctorId) {
    const { error } = await sb.from('profiles').update({ doctor_id: doctorId || null }).eq('id', profileId);
    if (error) throw error;
  }

  async function isPlatformAdmin() {
    if (!(await isLoggedIn())) return false;
    const { data, error } = await sb.rpc('is_platform_admin');
    if (error) throw error;
    return !!data;
  }

  function normalizeAdminClinic(row) {
    return {
      id: row.id,
      name: row.name,
      adminEmail: row.admin_email,
      phone: row.phone,
      subscriptionStatus: row.subscription_status,
      trialEndsAt: row.trial_ends_at,
      subscriptionFeeInr: row.subscription_fee_inr,
      adminNote: row.admin_note,
      subscriptionPaidFrom: row.subscription_paid_from,
      subscriptionPaidTo: row.subscription_paid_to,
      lastPatientAddedAt: row.last_patient_added_at,
      createdAt: row.created_at,
    };
  }

  async function listPlatformClinics() {
    const { data, error } = await sb.rpc('admin_list_clinics');
    if (error) throw error;
    return data.map(normalizeAdminClinic);
  }

  async function updateClinicSubscription(clinicId, fields) {
    const { error } = await sb.rpc('admin_update_clinic_subscription', {
      target_clinic_id: clinicId,
      new_status: fields.status,
      new_paid_from: fields.paidFrom || null,
      new_paid_to: fields.paidTo || null,
      new_trial_ends_at: fields.trialEndsAt || null,
      new_fee_inr: fields.feeInr === '' || fields.feeInr == null ? null : Number(fields.feeInr),
      new_note: fields.note || null,
    });
    if (error) throw error;
  }

  function normalizePlatformAdmin(row) {
    return {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      phone: row.phone,
      isActive: row.is_active,
      createdAt: row.created_at,
    };
  }

  async function listPlatformAdmins() {
    const { data, error } = await sb.rpc('admin_list_platform_admins');
    if (error) throw error;
    return data.map(normalizePlatformAdmin);
  }

  async function createPlatformAdmin({ email, password, fullName, phone }) {
    const tempClient = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await tempClient.auth.signUp({ email, password });
    if (error) throw error;
    const { error: linkError } = await sb.rpc('create_platform_admin', {
      new_user_id: data.user.id,
      admin_full_name: fullName,
      admin_phone: phone || null,
    });
    if (linkError) throw linkError;
  }

  async function updatePlatformAdmin(adminId, { fullName, phone }) {
    const { error } = await sb.rpc('admin_update_platform_admin', {
      target_id: adminId,
      new_full_name: fullName,
      new_phone: phone || null,
    });
    if (error) throw error;
  }

  async function setPlatformAdminActive(adminId, isActive) {
    const { error } = await sb.rpc('set_platform_admin_active', {
      target_id: adminId,
      new_active: isActive,
    });
    if (error) throw error;
  }

  const featureCache = {};
  async function hasFeature(key) {
    if (!(key in featureCache)) {
      featureCache[key] = (async () => {
        const { data, error } = await sb.rpc('has_feature', { target_feature_key: key });
        if (error) throw error;
        return !!data;
      })();
      // A failed lookup isn't remembered; the next call retries.
      featureCache[key].catch(() => { delete featureCache[key]; });
    }
    return featureCache[key];
  }

  const FEATURE_NAV_MAP = {
    revenueNavLink: 'insights',
    trendsNavLink: 'insights',
    medicinesPanel: 'pharmacy',
    pharmacyOptionCard: 'pharmacy',
    patientDirectoryPanel: 'patient_directory',
    billingAuditPanel: 'billing_audit',
  };
  async function applyFeatureNavGating() {
    // The distinct flags on this page are looked up together (they used to
    // be awaited one after another before first paint), and one failed
    // lookup leaves that item visible rather than aborting the rest -- the
    // server enforces the flag either way, this only hides links.
    const present = Object.entries(FEATURE_NAV_MAP).filter(([id]) => document.getElementById(id));
    const keys = [...new Set(present.map(([, key]) => key))];
    const results = await Promise.all(keys.map((key) => hasFeature(key).then((on) => [key, on], () => [key, true])));
    const enabled = Object.fromEntries(results);
    present.forEach(([id, key]) => {
      if (!enabled[key]) document.getElementById(id).style.display = 'none';
    });
  }

  async function adminGetClinicFeatures(clinicId) {
    const { data, error } = await sb.rpc('admin_get_clinic_features', { target_clinic_id: clinicId });
    if (error) throw error;
    const flags = {};
    data.forEach((row) => { flags[row.feature_key] = row.enabled; });
    return flags;
  }

  async function adminSetClinicFeatures(clinicId, flags) {
    const { error } = await sb.rpc('admin_set_clinic_features', {
      target_clinic_id: clinicId,
      pharmacy_enabled: !!flags.pharmacy,
      insights_enabled: !!flags.insights,
      billing_audit_enabled: !!flags.billing_audit,
      patient_directory_enabled: !!flags.patient_directory,
    });
    if (error) throw error;
  }

  async function adminGetClinicTeam(clinicId) {
    const { data, error } = await sb.rpc('admin_get_clinic_team', { target_clinic_id: clinicId });
    if (error) throw error;
    return data.map((row) => ({
      id: row.id,
      fullName: row.full_name,
      email: row.email,
      role: row.role,
      isActive: row.is_active,
    }));
  }

  async function adminGetClinicPatientVolume(clinicId, startDate, endDate) {
    const { data, error } = await sb.rpc('admin_get_clinic_patient_volume', {
      target_clinic_id: clinicId,
      p_start: startDate || null,
      p_end: endDate || null,
    });
    if (error) throw error;
    const row = data[0] || { booked_count: 0, seen_count: 0 };
    return { bookedCount: row.booked_count, seenCount: row.seen_count };
  }

  async function adminListContactEnquiries() {
    const { data, error } = await sb.rpc('admin_list_contact_enquiries');
    if (error) throw error;
    return data.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      name: row.name,
      phone: row.phone,
      clinicType: row.clinic_type,
      clinicName: row.clinic_name,
      city: row.city,
      message: row.message,
      status: row.status,
    }));
  }

  async function adminSetEnquiryStatus(id, status) {
    const { error } = await sb.rpc('admin_set_enquiry_status', { target_id: id, new_status: status });
    if (error) throw error;
  }

  async function adminListProductFeedback() {
    const { data, error } = await sb.rpc('admin_list_product_feedback');
    if (error) throw error;
    return data.map((row) => ({
      id: row.id,
      clinicName: row.clinic_name,
      patientName: row.patient_name,
      rating: row.rating,
      feedbackText: row.feedback_text,
      submittedAt: row.submitted_at,
    }));
  }

  async function adminListClientErrors() {
    const { data, error } = await sb.rpc('admin_list_client_errors');
    if (error) throw error;
    return data.map((row) => ({
      page: row.page,
      message: row.message,
      occurrenceCount: row.occurrence_count,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      clinicCount: row.clinic_count,
    }));
  }

  function getTheme() {
    return localStorage.getItem('qlinic_theme') || 'light';
  }

  function setTheme(theme) {
    localStorage.setItem('qlinic_theme', theme);
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  // Mobile nav drawer: runs on every .app-shell page (this script tag
  // always sits right after that markup, so the DOM is already there).
  // No-ops instantly on pages without a sidebar (marketing, auth). Only
  // one shared <nav>, not a second copy for mobile, so the existing
  // role-based show/hide of individual nav links (each page's own inline
  // script) keeps working unchanged.
  function initMobileNav() {
    const shell = document.querySelector('.app-shell');
    const sidebar = document.querySelector('.app-sidebar');
    if (!shell || !sidebar) return;

    const topbar = document.createElement('div');
    topbar.className = 'mobile-topbar';
    topbar.innerHTML =
      '<button type="button" class="mobile-nav-toggle" aria-label="Open menu" aria-expanded="false">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>' +
      '</button>' +
      '<span class="mobile-topbar-brand">ClinVision</span>';
    shell.insertBefore(topbar, shell.firstChild);

    const backdrop = document.createElement('div');
    backdrop.className = 'mobile-nav-backdrop';
    shell.appendChild(backdrop);

    const toggleBtn = topbar.querySelector('.mobile-nav-toggle');
    function openNav() {
      sidebar.classList.add('mobile-nav-open');
      backdrop.classList.add('show');
      toggleBtn.setAttribute('aria-expanded', 'true');
    }
    function closeNav() {
      sidebar.classList.remove('mobile-nav-open');
      backdrop.classList.remove('show');
      toggleBtn.setAttribute('aria-expanded', 'false');
    }
    toggleBtn.addEventListener('click', () => {
      if (sidebar.classList.contains('mobile-nav-open')) closeNav(); else openNav();
    });
    backdrop.addEventListener('click', closeNav);
    sidebar.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeNav));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeNav();
    });

    // Fallback for a browser too old for the CSS :has() selector styles.css
    // relies on to give a qtable's .panel horizontal scroll on mobile --
    // an unsupported :has() rule is just silently dropped by that
    // browser's CSS parser, with no error, so this can't detect and warn,
    // only compensate. Most tables render well after this script runs
    // (an async data fetch), so this has to keep re-checking, not just
    // run once at load.
    function markQtablePanels() {
      if (!window.matchMedia('(max-width: 720px)').matches) return;
      document.querySelectorAll('.panel').forEach((p) => {
        const has = !!p.querySelector('table.qtable');
        if (has !== p.classList.contains('has-qtable-scroll')) p.classList.toggle('has-qtable-scroll', has);
      });
    }
    markQtablePanels();
    let qtableScanTimer = null;
    new MutationObserver(() => {
      clearTimeout(qtableScanTimer);
      qtableScanTimer = setTimeout(markQtablePanels, 150);
    }).observe(document.body, { childList: true, subtree: true });
  }
  initMobileNav();

  // ---------- Shared Rx-composer helpers ----------
  // Write Prescription (doctor.html) and Quick Walk-In Rx
  // (prescriptions.html) each built their own copy of these. They're
  // pure enough (no page-specific DOM ids baked in) to share for real
  // instead of maintaining two copies that quietly drift apart.

  // follow_up_date (and other saved-prescription dates) is a bare
  // "YYYY-MM-DD" -- new Date() on a date-only string parses it as UTC
  // midnight, which toLocaleDateString() then rolls back a day for any
  // viewer in a negative-UTC-offset timezone. Build the Date from its
  // own Y/M/D components instead (same approach as formatDateLabel above,
  // just without that one's "Today"/"Tomorrow" relative labels).
  function formatDateOnly(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // Vitals are numbers (plus / for BP's "120/80"), never free text, and
  // never legitimately negative -- strips anything else as it's typed.
  function sanitizeVitalInput(value) {
    return value.replace(/[^0-9/.]/g, '');
  }

  // Plausibility bounds, not "normal" bounds -- wide enough to admit any
  // real clinical reading, including documented extremes, while still
  // catching keyboard-mashing like "2222222222" that sails straight
  // through sanitizeVitalInput above (every one of those characters is
  // individually a valid vitals character; only the resulting VALUE is
  // nonsense). A genuine outside-this-range emergency reading is rare
  // enough, and important enough, that it deserves a doctor's free-text
  // note, not a wider number here.
  const VITAL_BOUNDS = {
    bpSystolic: [40, 300],
    bpDiastolic: [20, 200],
    pulse: [20, 300],
    temp: [90, 110],
    weight: [0.5, 300],
  };

  // kind: 'bp' | 'pulse' | 'temp' | 'weight'. Every vital is optional, so
  // an empty value is always valid. Returns { ok: true } or
  // { ok: false, message } for a toast naming the field and the expected
  // range.
  function validateVital(kind, value) {
    const v = (value || '').trim();
    if (!v) return { ok: true };
    if (kind === 'bp') {
      const m = /^(\d{1,3})\/(\d{1,3})$/.exec(v);
      if (!m) return { ok: false, message: 'BP should look like 120/80' };
      const [sysMin, sysMax] = VITAL_BOUNDS.bpSystolic;
      const [diaMin, diaMax] = VITAL_BOUNDS.bpDiastolic;
      const sys = Number(m[1]);
      const dia = Number(m[2]);
      if (sys < sysMin || sys > sysMax || dia < diaMin || dia > diaMax) {
        return { ok: false, message: `BP looks implausible -- expected roughly ${sysMin}-${sysMax}/${diaMin}-${diaMax} mmHg` };
      }
      return { ok: true };
    }
    const bounds = VITAL_BOUNDS[kind];
    const n = Number(v);
    if (!Number.isFinite(n)) return { ok: false, message: 'Enter a valid number' };
    const [min, max] = bounds;
    if (n < min || n > max) {
      const label = { pulse: 'Pulse', temp: 'Temp', weight: 'Weight' }[kind];
      const unit = { pulse: 'bpm', temp: '°F', weight: 'kg' }[kind];
      return { ok: false, message: `${label} looks implausible -- expected roughly ${min}-${max} ${unit}` };
    }
    return { ok: true };
  }

  // The vitals + tests-ordered sidebar block, shared by both composers'
  // live preview/print and by prescriptions.html's printed history.
  function buildRxSidebarHtml({ vitalsBp, vitalsPulse, vitalsTemp, vitalsWeight, testsOrdered }) {
    const hasVitals = vitalsBp || vitalsPulse || vitalsTemp || vitalsWeight;
    const vitalsHtml = hasVitals ? `
      <div class="rx-vital-block">
        <span class="lbl">Vitals</span>
        ${vitalsBp ? `<div class="rx-vital-line"><span class="vk">BP:</span> ${escapeHtml(vitalsBp)} mmHg</div>` : ''}
        ${vitalsPulse ? `<div class="rx-vital-line"><span class="vk">Pulse:</span> ${escapeHtml(vitalsPulse)} bpm</div>` : ''}
        ${vitalsTemp ? `<div class="rx-vital-line"><span class="vk">Temp:</span> ${escapeHtml(vitalsTemp)}°F</div>` : ''}
        ${vitalsWeight ? `<div class="rx-vital-line"><span class="vk">Weight:</span> ${escapeHtml(vitalsWeight)} kg</div>` : ''}
      </div>
    ` : '';
    const testsHtml = (testsOrdered && testsOrdered.length) ? `
      <div class="rx-vital-block">
        <span class="lbl">Tests advised</span>
        ${testsOrdered.map((t) => `<div class="rx-sidebar-test-item">${escapeHtml(t)}</div>`).join('')}
      </div>
    ` : '';
    return (vitalsHtml || testsHtml) ? `<div class="rx-sidebar">${vitalsHtml}${testsHtml}</div>` : '';
  }

  // Vitals as icon cards, tests as a checklist, clinical details and the
  // medicine table in their own panels, advice/follow-up grouped on the
  // right -- the past-prescription detail view shared by doctor.html's
  // history popup and prescriptions.html's history tab. showPrintButton
  // is the one real difference between the two call sites: prescriptions.html
  // can print a historical Rx from here, doctor.html's popup never wires
  // printing so it leaves the button out entirely rather than rendering
  // a dead one.
  function buildRxDetailPanelsHtml(rx, { showPrintButton = false } = {}) {
    const vitalDefs = [
      { label: 'Pulse', value: rx.vitalsPulse ? `${rx.vitalsPulse} bpm` : '', cls: 'pulse', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>' },
      { label: 'Temp', value: rx.vitalsTemp ? `${rx.vitalsTemp}°F` : '', cls: 'temp', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/></svg>' },
      { label: 'Weight', value: rx.vitalsWeight ? `${rx.vitalsWeight} kg` : '', cls: 'weight', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5h5"/></svg>' },
      { label: 'BP', value: rx.vitalsBp ? `${rx.vitalsBp} mmHg` : '', cls: 'bp', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-4.5-9.33-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.33 6c-2.33 4.5-9.33 9-9.33 9Z"/></svg>' },
    ].filter((v) => v.value);
    const testsOrdered = rx.testsOrdered || [];
    const hasLeft = vitalDefs.length > 0 || testsOrdered.length > 0;

    const leftHtml = hasLeft ? `
      <div>
        ${vitalDefs.length ? `
          <div class="rx-panel-h">Vitals</div>
          <div class="rx-vitals-grid-view">
            ${vitalDefs.map((v) => `
              <div class="rx-vital-card">
                <div class="rx-vital-icon ${v.cls}">${v.icon}</div>
                <div class="rx-vital-label">${v.label.toUpperCase()}</div>
                <div class="rx-vital-value">${escapeHtml(v.value)}</div>
              </div>
            `).join('')}
          </div>
        ` : ''}
        ${testsOrdered.length ? `
          <div class="rx-panel-h">Tests advised</div>
          <div class="rx-tests-list">
            ${testsOrdered.map((t) => `<div class="rx-test-item"><span class="rx-test-check"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>${escapeHtml(t)}</div>`).join('')}
          </div>
        ` : ''}
      </div>
    ` : '';

    const medsHtml = rx.items.length
      ? rx.items.map((item, i) => `
          <tr>
            <td style="color:var(--grey-500);">${i + 1}</td>
            <td><div class="rt-name">${escapeHtml(item.name)}${item.composition ? ` <span class="rt-comp" style="font-weight:400;">(${escapeHtml(item.composition)})</span>` : ''}</div>${item.instructions ? `<div class="rt-instr">${escapeHtml(item.instructions)}</div>` : ''}</td>
            <td><span class="rt-dose"><span class="rx-pill-icon"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="8" rx="4"/><path d="M8 8v8"/></svg></span>${escapeHtml(item.frequency)}</span></td>
            <td>${escapeHtml(item.durationText)}</td>
          </tr>
        `).join('')
      : '<tr><td colspan="4" style="color:var(--grey-500);font-style:italic;">No medicines recorded</td></tr>';

    return `
      <div class="rx-detail-grid${hasLeft ? '' : ' no-left'}">
        ${leftHtml}
        <div>
          ${(rx.complaints || rx.diagnosis) ? `
            <div class="rx-panel-h">Clinical details</div>
            <div class="rx-clinical-grid">
              ${rx.complaints ? `<div class="rx-clinical-box"><div class="k">Chief complaint</div><div class="v">${escapeHtml(rx.complaints)}</div></div>` : ''}
              ${rx.diagnosis ? `<div class="rx-clinical-box"><div class="k">Diagnosis</div><div class="v">${escapeHtml(rx.diagnosis)}</div></div>` : ''}
            </div>
          ` : ''}
          <div class="rx-panel-h">Prescription (Rx)</div>
          <table class="rx-table">
            <thead><tr><th style="width:16px;">#</th><th>Medicine</th><th>Dosage</th><th>Duration</th></tr></thead>
            <tbody>${medsHtml}</tbody>
          </table>
        </div>
        <div>
          ${rx.advice ? `
            <div class="rx-panel-h">Advice</div>
            <div class="rx-advice-box"><div class="v">${escapeHtml(rx.advice)}</div></div>
          ` : ''}
          ${rx.followUpDate ? `
            <div class="rx-followup-chip">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
              <div><span class="f-date">Follow up</span>${escapeHtml(formatDateOnly(rx.followUpDate))}</div>
            </div>
          ` : ''}
          ${showPrintButton ? `
            <button type="button" class="rx-print-btn" data-print-id="${rx.id}">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
              Print
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }

  // Validates and shapes one prescription-line item from the composer's
  // draft-medicine fields. Used by both "+ Add this medicine" and by the
  // save action itself (so a medicine that's typed but never explicitly
  // added isn't silently left off the saved/printed prescription).
  // Returns { ok: false, field } naming the first empty required field,
  // or { ok: true, item } ready to push onto the composer's items array
  // -- a prescription line with no dosing schedule is clinically
  // meaningless, so name/frequency/duration aren't optional.
  function buildDraftMedicineItem({ name, frequency, durationText, instructions, draftMed }) {
    if (!name) return { ok: false, field: 'name' };
    if (!frequency) return { ok: false, field: 'frequency' };
    if (!durationText) return { ok: false, field: 'duration' };
    return {
      ok: true,
      item: {
        clinicMedicineId: draftMed ? draftMed.clinicMedicineId : null,
        genericMedicineId: draftMed ? draftMed.genericMedicineId : null,
        freeTextName: draftMed ? null : name,
        name,
        composition: draftMed ? draftMed.composition : '',
        frequency,
        durationText,
        instructions: instructions || '',
      },
    };
  }

  // True once the composer has anything typed that isn't saved yet --
  // used to warn before an ordinary close/reopen discards it, and before
  // an accidental tab close/refresh does. DOM reads stay in the caller
  // (each page's fields live under different ids); this just applies the
  // one shared rule to whatever values it's handed.
  function hasUnsavedRxContent({ itemCount, fieldValues, testsCount }) {
    if (itemCount) return true;
    if (fieldValues.some((v) => v && v.trim())) return true;
    return !!testsCount;
  }

  // items: [{ clinicMedicineId, genericMedicineId, freeTextName, name, composition, frequency, durationText, instructions }]
  // patientId is optional (Quick Walk-In Rx) — omit it and pass
  // walkinName/walkinAge/walkinGender/walkinPhone instead for a
  // prescription that isn't linked to any patients row at all.
  async function createPrescription({ patientId, complaints, diagnosis, advice, followUpDate, items, doctorId, vitalsBp, vitalsPulse, vitalsTemp, vitalsWeight, testsOrdered, walkinName, walkinAge, walkinGender, walkinPhone }) {
    const payload = (items || []).map((it) => ({
      clinic_medicine_id: it.clinicMedicineId || null,
      generic_medicine_id: it.genericMedicineId || null,
      free_text_name: it.clinicMedicineId || it.genericMedicineId ? null : (it.freeTextName || it.name || null),
      frequency: it.frequency || '',
      duration_text: it.durationText || '',
      instructions: it.instructions || '',
    }));
    const { data, error } = await sb.rpc('create_prescription', {
      p_patient_id: patientId || null,
      p_complaints: complaints || '',
      p_diagnosis: diagnosis || '',
      p_advice: advice || '',
      p_follow_up_date: followUpDate || null,
      p_items: payload,
      // Only meaningful for an admin caller — the server always writes a
      // doctor's own prescriptions under their own linked doctor_id and
      // ignores this for a 'doctor' role, so a doctor can never be sent
      // in as someone else.
      p_doctor_id: doctorId || null,
      p_vitals_bp: vitalsBp || '',
      p_vitals_pulse: vitalsPulse || '',
      p_vitals_temp: vitalsTemp || '',
      p_vitals_weight: vitalsWeight || '',
      p_tests_ordered: testsOrdered || [],
      p_walkin_name: walkinName || null,
      // ?? (not ||) so a genuine walk-in age of 0 (a newborn) isn't
      // coerced into "not provided" the way a falsy-zero check would.
      p_walkin_age: walkinAge ?? null,
      p_walkin_gender: walkinGender || null,
      p_walkin_phone: walkinPhone || null,
    });
    if (error) throw error;
    return data;
  }

  function normalizePrescriptionRow(row) {
    return {
      id: row.id,
      createdAt: row.created_at,
      complaints: row.complaints || '',
      diagnosis: row.diagnosis || '',
      advice: row.advice || '',
      followUpDate: row.follow_up_date || null,
      vitalsBp: row.vitals_bp || '',
      vitalsPulse: row.vitals_pulse || '',
      vitalsTemp: row.vitals_temp || '',
      vitalsWeight: row.vitals_weight || '',
      testsOrdered: row.tests_ordered || [],
      isWalkin: !!row.is_walkin,
      patientName: row.patient_name,
      patientAge: row.patient_age,
      patientGender: row.patient_gender,
      patientPhone: row.patient_phone,
      doctorId: row.doctor_id || null,
      doctorName: row.doctor_name,
      doctorSpecialty: row.doctor_specialty || '',
      doctorQualification: row.doctor_qualification || '',
      doctorRegistrationNumber: row.doctor_registration_number || '',
      items: (row.items || []).map((it) => ({
        name: it.name,
        composition: it.composition || '',
        frequency: it.frequency || '',
        durationText: it.durationText || '',
        instructions: it.instructions || '',
      })),
    };
  }

  async function canAccessPrescriptions() {
    const profile = await getMyProfile();
    return !!profile && profile.isActive && (profile.role === 'admin' || profile.role === 'doctor');
  }

  async function getPatientPrescriptions(patientId) {
    const { data, error } = await sb.rpc('get_patient_prescriptions', { p_patient_id: patientId });
    if (error) throw error;
    return (data || []).map(normalizePrescriptionRow);
  }

  // Prescriptions' own default (empty search) view — every prescription
  // the caller can see, most recent first, not scoped to any date.
  async function getClinicPrescriptions({ doctorId } = {}) {
    const { data, error } = await sb.rpc('get_clinic_prescriptions', { p_doctor_id: doctorId || null });
    if (error) throw error;
    return (data || []).map(normalizePrescriptionRow);
  }

  // endDate is optional — omitted, this is a single day (p_date); given,
  // the server widens it to an inclusive [date, endDate] range, which is
  // all Prescriptions' own period picker (Today/Yesterday/This week/
  // This month/Custom) actually needs.
  async function getClinicPrescriptionsByDate({ date, doctorId, endDate }) {
    const { data, error } = await sb.rpc('get_clinic_prescriptions_by_date', {
      p_date: date, p_doctor_id: doctorId || null, p_end_date: endDate || null,
    });
    if (error) throw error;
    return (data || []).map(normalizePrescriptionRow);
  }

  async function searchClinicPrescriptions(query) {
    const { data, error } = await sb.rpc('search_clinic_prescriptions', { p_query: query || '' });
    if (error) throw error;
    return (data || []).map(normalizePrescriptionRow);
  }

  async function onLiveChange(cb, options) {
    const mustBeLive = (options && options.tables) || ['patients', 'doctors'];
    const clinicId = await ensureClinicContext();
    if (!clinicId) return;
    let debounceTimer = null;
    function debouncedCb(payload) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => cb(payload), 300);
    }
    // One channel per table: if a table is missing from the realtime publication only that
    // channel fails, the others keep working. Money (invoices) is watched too, so Revenue,
    // Insights and the Dashboard follow a bill the moment it is created or adjusted.
    const watched = [
      { table: 'patients', filter: `clinic_id=eq.${clinicId}` },
      { table: 'doctors', filter: `clinic_id=eq.${clinicId}` },
      { table: 'doctor_holidays', filter: `clinic_id=eq.${clinicId}` },
      { table: 'staff_holidays', filter: `clinic_id=eq.${clinicId}` },
      { table: 'clinic_closures', filter: `clinic_id=eq.${clinicId}` },
      { table: 'invoices', filter: `clinic_id=eq.${clinicId}` },
      { table: 'visit_feedback', filter: `clinic_id=eq.${clinicId}` },
      { table: 'clinics', filter: `id=eq.${clinicId}` },
    ];
    const subscribed = {};
    let lastRefresh = Date.now();
    function refresh(payload) {
      lastRefresh = Date.now();
      debouncedCb(payload);
    }
    watched.forEach((w) => {
      let wasSubscribed = false;
      sb.channel('clinic-' + clinicId + '-' + w.table)
        .on('postgres_changes', { event: '*', schema: 'public', table: w.table, filter: w.filter }, refresh)
        .subscribe((status) => {
          subscribed[w.table] = status === 'SUBSCRIBED';
          // Back after a dropped connection: whatever happened in between was missed.
          if (status === 'SUBSCRIBED' && wasSubscribed) refresh();
          if (status === 'SUBSCRIBED') wasSubscribed = true;
        });
    });
    // Safety nets so a page never sits on old numbers:
    // - coming back to the tab or the network after a while refreshes it;
    // - if a table this page depends on is not connected, refresh every 30 seconds instead;
    // - the day changing at midnight refreshes it.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRefresh > 30000) refresh();
    });
    window.addEventListener('online', () => refresh());
    let knownDay = todayDateStr();
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const day = todayDateStr();
      // Only the tables this page depends on decide this: a role that may not read some other
      // table gets no events from it and must not put the page on permanent polling.
      const allLive = mustBeLive.every((t) => subscribed[t]);
      if (day !== knownDay || (!allLive && Date.now() - lastRefresh > 30000)) {
        knownDay = day;
        refresh();
      }
    }, 15000);
  }

  function normalizeMedicine(row) {
    return {
      id: row.id,
      name: row.name,
      genericName: row.generic_name,
      manufacturer: row.manufacturer,
      form: row.form,
      strength: row.strength,
      packLabel: row.pack_label,
      packSize: row.pack_size,
      dispenseUnit: row.dispense_unit,
      barcode: row.barcode,
      schedule: row.schedule,
      trackBatches: row.track_batches,
      referenceNumber: row.reference_number,
      mrp: Number(row.mrp),
      sellingPrice: Number(row.selling_price),
      gstRate: Number(row.gst_rate),
      hsnCode: row.hsn_code,
      stockQuantity: row.stock_quantity,
      isActive: row.is_active,
      createdAt: row.created_at,
    };
  }

  function normalizeMedicineBatch(row) {
    return {
      id: row.id,
      medicineId: row.medicine_id,
      batchNumber: row.batch_number,
      mfgDate: row.mfg_date,
      expiryDate: row.expiry_date,
      purchasePrice: Number(row.purchase_price),
      mrp: Number(row.mrp),
      quantityReceived: row.quantity_received,
      quantityRemaining: row.quantity_remaining,
      createdAt: row.created_at,
    };
  }

  function normalizeStockLedgerEntry(row) {
    const invoice = Array.isArray(row.invoices) ? row.invoices[0] : row.invoices;
    const batch = Array.isArray(row.medicine_batches) ? row.medicine_batches[0] : row.medicine_batches;
    return {
      id: row.id,
      medicineId: row.medicine_id,
      batchId: row.batch_id,
      batchNumber: batch ? batch.batch_number : null,
      movementType: row.movement_type,
      quantityDelta: row.quantity_delta,
      closingStockAfter: row.closing_stock_after,
      referenceInvoiceId: row.reference_invoice_id,
      referenceInvoiceLabel: invoice ? 'PH-' + String(invoice.invoice_number).padStart(4, '0') : null,
      note: row.note,
      createdAt: row.created_at,
    };
  }

  function normalizeInvoiceItem(row) {
    return {
      id: row.id,
      invoiceId: row.invoice_id,
      medicineId: row.medicine_id,
      batchId: row.batch_id,
      medicineName: row.medicine_name_snapshot,
      hsnCode: row.hsn_code_snapshot,
      quantity: row.quantity,
      unitPrice: Number(row.unit_price),
      gstRate: Number(row.gst_rate),
      lineTotal: Number(row.line_total),
    };
  }

  async function getMedicines({ activeOnly = true, search = '' } = {}) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    const data = await fetchAllRows((from, to) => {
      let query = sb.from('medicines').select('*').eq('clinic_id', clinicId);
      if (activeOnly) query = query.eq('is_active', true);
      if (search) query = query.ilike('name', `%${search}%`);
      return query.order('name').order('id').range(from, to);
    });
    return data.map(normalizeMedicine);
  }

  // Clinic's own stocked medicines first (a real dispense match), then the
  // national reference list -- so a clinic with no pharmacy set up still
  // gets real results on day one, and a clinic that DOES stock the item
  // sees its own catalog entry ranked ahead of it.
  // A clinic's own catalog is small (tens to low hundreds of rows) — worth
  // loading once and filtering in the browser so it's instant, the way
  // pharmacy.html's own medicine search already is. The 250k-row national
  // generic_medicines list is the part a network round trip can't avoid;
  // that stays a server search, called separately as a slower enrichment
  // layer rather than something the whole dropdown waits on.
  async function getClinicMedicinesForRx() {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    const data = await fetchAllRows((from, to) => sb.from('medicines').select('id, name, generic_name, manufacturer')
      .eq('clinic_id', clinicId).eq('is_active', true).order('name').order('id').range(from, to));
    return data.map((r) => ({
      clinicMedicineId: r.id, genericMedicineId: null,
      name: r.name, composition: r.generic_name || '', manufacturer: r.manufacturer || '',
    }));
  }

  async function searchMedicinesForRx(query, signal) {
    const q = (query || '').trim();
    if (q.length < 2) return [];
    // Prefix match ("dolo%"), not substring ("%dolo%") — this is how a
    // doctor actually types a medicine name, and it lets the generic_
    // medicines trigram index (250k+ rows) narrow the scan far more than
    // a leading wildcard would.
    let qb = sb.from('generic_medicines').select('id, name, manufacturer, composition_1, composition_2')
      .ilike('name', `${q}%`).order('name').limit(12);
    if (signal) qb = qb.abortSignal(signal);
    const { data, error } = await qb;
    if (error) throw error;
    return data.map((r) => ({
      clinicMedicineId: null, genericMedicineId: r.id,
      name: r.name, composition: [r.composition_1, r.composition_2].filter(Boolean).join(' + '), manufacturer: r.manufacturer || '',
    }));
  }

  async function getMedicine(id) {
    const { data, error } = await sb.from('medicines').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data ? normalizeMedicine(data) : null;
  }

  async function addMedicine({ name, genericName, manufacturer, form, strength, packLabel, packSize, dispenseUnit, barcode, schedule, trackBatches, referenceNumber, mrp, sellingPrice, gstRate, hsnCode }) {
    const clinicId = await ensureClinicContext();
    const { data, error } = await sb.from('medicines').insert({
      clinic_id: clinicId,
      name,
      generic_name: genericName || '',
      manufacturer: manufacturer || '',
      form: form || '',
      strength: strength || '',
      pack_label: packLabel || '',
      pack_size: Number(packSize) || 1,
      dispense_unit: dispenseUnit || '',
      barcode: barcode || null,
      schedule: schedule || 'none',
      track_batches: trackBatches !== false,
      reference_number: referenceNumber || '',
      mrp: Number(mrp) || 0,
      selling_price: Number(sellingPrice) || 0,
      gst_rate: gstRate == null ? 12 : Number(gstRate),
      hsn_code: hsnCode || '',
    }).select().single();
    if (error) throw error;
    return normalizeMedicine(data);
  }

  async function updateMedicine(id, { name, genericName, manufacturer, form, strength, packLabel, packSize, dispenseUnit, barcode, schedule, trackBatches, referenceNumber, mrp, sellingPrice, gstRate, hsnCode }) {
    const { data, error } = await sb.from('medicines').update({
      name,
      generic_name: genericName || '',
      manufacturer: manufacturer || '',
      form: form || '',
      strength: strength || '',
      pack_label: packLabel || '',
      pack_size: Number(packSize) || 1,
      dispense_unit: dispenseUnit || '',
      barcode: barcode || null,
      schedule: schedule || 'none',
      track_batches: trackBatches !== false,
      reference_number: referenceNumber || '',
      mrp: Number(mrp) || 0,
      selling_price: Number(sellingPrice) || 0,
      gst_rate: gstRate == null ? 12 : Number(gstRate),
      hsn_code: hsnCode || '',
    }).eq('id', id).select().single();
    if (error) throw error;
    return normalizeMedicine(data);
  }

  async function setMedicineActive(id, isActive) {
    const { error } = await sb.from('medicines').update({ is_active: isActive }).eq('id', id);
    if (error) throw error;
  }

  async function getMedicineBatches(medicineId) {
    const { data, error } = await sb.from('medicine_batches').select('*')
      .eq('medicine_id', medicineId)
      .order('expiry_date', { ascending: true, nullsFirst: false });
    if (error) throw error;
    return data.map(normalizeMedicineBatch);
  }

  async function getStockLedger(medicineId, { limit = 50 } = {}) {
    const { data, error } = await sb.from('stock_ledger').select('*, invoices!reference_invoice_id(invoice_number), medicine_batches!batch_id(batch_number)')
      .eq('medicine_id', medicineId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data.map(normalizeStockLedgerEntry);
  }

  async function recordStockPurchase({ medicineId, batchNumber, mfgDate, expiryDate, packsReceived, purchasePricePerPack, mrpPerPack }) {
    const { data, error } = await sb.rpc('record_stock_purchase', {
      p_medicine_id: medicineId,
      p_batch_number: batchNumber || '',
      p_mfg_date: mfgDate || null,
      p_expiry_date: expiryDate || null,
      p_packs_received: Number(packsReceived),
      p_purchase_price_per_pack: purchasePricePerPack == null ? 0 : Number(purchasePricePerPack),
      p_mrp_per_pack: mrpPerPack == null ? 0 : Number(mrpPerPack),
    });
    if (error) throw error;
    return normalizeMedicineBatch(data);
  }

  async function adjustStock({ medicineId, batchId, delta, note }) {
    const { error } = await sb.rpc('adjust_stock', {
      p_medicine_id: medicineId,
      p_batch_id: batchId,
      p_delta: Number(delta),
      p_note: note || '',
    });
    if (error) throw error;
  }

  async function createPharmacyInvoice({ patientId, patientName, patientPhone, paymentMode, amountReceived, items }) {
    // Read the typed amount strictly. Number('') is 0 (a cleared box
    // recorded "nothing received") and Number('1,200') is NaN, which JSON
    // turns into null, which the RPC treats as "paid in full" -- both
    // silently wrong. Anything that isn't a plain amount is refused.
    let receivedAmount = null;
    if (amountReceived !== null && amountReceived !== undefined) {
      const cleaned = String(amountReceived).replace(/[₹,\s]/g, '');
      receivedAmount = cleaned === '' ? NaN : Number(cleaned);
      if (!Number.isFinite(receivedAmount) || receivedAmount < 0) {
        throw new Error('Enter the amount received as a number, like 250 or 249.50 (0 if nothing was paid).');
      }
    }
    const { data, error } = await sb.rpc('create_pharmacy_invoice', {
      p_patient_id: patientId || null,
      p_patient_name: patientName || '',
      p_patient_phone: patientPhone || '',
      p_payment_mode: paymentMode || 'cash',
      p_amount_received: receivedAmount,
      p_items: items.map((i) => ({ medicine_id: i.medicineId, quantity: Number(i.quantity) })),
    });
    if (error) throw error;
    return normalizeInvoice(data);
  }

  async function searchPatientsForPharmacy(query) {
    const q = (query || '').trim();
    if (!q) return [];
    const { data, error } = await sb.rpc('search_patients_for_pharmacy', { p_query: q });
    if (error) throw error;
    return (data || []).map((row) => ({ id: row.id, name: row.name, phone: row.phone }));
  }

  async function getInvoiceItems(invoiceId) {
    const { data, error } = await sb.from('invoice_items').select('*').eq('invoice_id', invoiceId).order('created_at');
    if (error) throw error;
    return data.map(normalizeInvoiceItem);
  }

  // Another tab signing out or in as someone else must not leave this tab on the old clinic.
  let knownUserId = null;
  sb.auth.onAuthStateChange((event, session) => {
    const userId = session && session.user ? session.user.id : null;
    if (event === 'SIGNED_OUT' || (knownUserId && userId && userId !== knownUserId)) {
      currentClinicId = null;
      currentClinic = null;
      myProfilePromise = null;
      Object.keys(featureCache).forEach((key) => { delete featureCache[key]; });
    }
    knownUserId = userId;
  });

  global.Qlinic = {
    parseTime,
    formatTime,
    formatTimestamp,
    formatDateTime,
    getTodayDate: todayDateStr,
    formatDateLabel,
    isPastRealDateTime,
    lookupCityStateForPincode,
    INDIA_STATES_AND_UTS,

    getClinic,
    updateClinic,
    uploadClinicLogo,
    removeClinicLogo,
    getClinicClosures,
    addClinicClosure,
    updateClinicClosure,
    deleteClinicClosure,
    getDoctorHolidays,
    addDoctorHoliday,
    updateDoctorHoliday,
    deleteDoctorHoliday,
    getStaffHolidays,
    addStaffHoliday,
    updateStaffHoliday,
    deleteStaffHoliday,
    getDoctors,
    getDoctor,
    addDoctor,
    updateDoctor,
    setDoctorActive,
    doctorLabel,
    passwordStrength,
    attachPasswordMeter,
    attachPasswordConfirm,
    attachPasswordReveal,
    copyToClipboard,

    getQueueForDoctor,
    getAllQueues,
    getDailyBoardCode,
    redeemDailyBoardCode,
    getDisplayBoardBySession,
    intendedMoment,
    effectiveMoment,
    searchBookedPatients,
    updatePatientContact,
    getPatientLookupByPhone,
    getPatientDirectory,
    checkFollowUpEligibility,
    getBillingPatientLookup,
    createInvoice,
    getTodayInvoices,
    getInvoicesForDate,
    getInvoicesForDateRange,
    getOutstandingInvoices,
    getPatientsInRange,
    getNoShowsForDate,
    getNoShowsForDateRange,
    hasAppointmentOnDate,
    getInvoiceById,
    getBillingAudit,
    updateInvoicePayment,
    markArrived,
    markNoShow,
    addWalkIn,
    addAppointment,
    callNextPatient,
    finishCurrentPatient,
    setDoctorStatus,
    getSlotAvailability,
    getDaySlotSchedule,
    slotScheduleDialog,
    statBreakdownDialog,
    getDailySummary,
    closeDayNoShows,
    getTodayCloseoutCounts,
    reopenDay,
    closeDoctorDay,
    reopenDoctorDay,
    isDoctorClosedToday,
    isClosedUntilReset,
    isClinicClosedToday,
    isRealStatusReason,
    escapeHtml,
    pagerHtml,
    wirePager,
    scrollToTop,
    confirmDialog,
    openAdjustBillingModal,
    attachDatePicker,
    shouldFlipUp,
    getQueueStatus,
    isWhatsAppConfirmEnabled,
    whatsappUrlFor,
    buildWhatsAppMessage,
    submitProductFeedback,
    submitVisitFeedback,
    getClinicFeedback,

    signUp,
    login,
    logout,
    isLoggedIn,
    requireLogin,
    isSubscriptionActive,
    getCurrentUserEmail,
    changeEmail,
    changePassword,
    requestPasswordReset,
    completePasswordReset,

    getMyProfile,
    isAdmin,
    canAccessBilling,
    isDoctor,
    isPharmacist,
    canAccessPharmacy,
    getMyDoctorId,
    getTeam,
    createStaffAccount,
    setStaffActive,
    updateStaffRole,
    updateStaffName,
    updateStaffDoctorLink,
    updateStaffPhone,
    updateMyPhone,

    isPlatformAdmin,
    listPlatformClinics,
    updateClinicSubscription,
    listPlatformAdmins,
    createPlatformAdmin,
    updatePlatformAdmin,
    setPlatformAdminActive,

    hasFeature,
    applyFeatureNavGating,
    adminGetClinicFeatures,
    adminSetClinicFeatures,
    adminGetClinicTeam,
    adminGetClinicPatientVolume,
    adminListContactEnquiries,
    adminSetEnquiryStatus,
    adminListProductFeedback,
    adminListClientErrors,

    getTheme,
    setTheme,

    getMedicines,
    getMedicine,
    addMedicine,
    updateMedicine,
    setMedicineActive,
    getMedicineBatches,
    getStockLedger,
    recordStockPurchase,
    adjustStock,
    createPharmacyInvoice,
    getInvoiceItems,
    searchPatientsForPharmacy,

    getClinicMedicinesForRx,
    searchMedicinesForRx,
    createPrescription,
    canAccessPrescriptions,
    getPatientPrescriptions,
    getClinicPrescriptions,
    getClinicPrescriptionsByDate,
    searchClinicPrescriptions,
    formatDateOnly,
    sanitizeVitalInput,
    validateVital,
    buildRxSidebarHtml,
    buildRxDetailPanelsHtml,
    buildDraftMedicineItem,
    hasUnsavedRxContent,
    getMyDisplayName,
    initialsFor,
    hashIndex,

    onLiveChange,
  };
})(window);
