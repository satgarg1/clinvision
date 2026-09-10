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

  function wirePager(containerEl, page, totalPages, onChange) {
    if (!containerEl) return;
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

  function confirmDialog({ title, message, confirmLabel = 'Continue', cancelLabel = 'Cancel', danger = false } = {}) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal-card" role="alertdialog" aria-modal="true">
          ${title ? `<h2 class="modal-title">${escapeHtml(title)}</h2>` : ''}
          ${message.split('\n').map((line) => `<p class="modal-message">${escapeHtml(line)}</p>`).join('')}
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
        btn.addEventListener('click', () => { viewDate.setFullYear(y); showMonthView(); });
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
        btn.addEventListener('click', () => { viewDate.setMonth(i); showDayView(); });
        el.appendChild(btn);
      });
    }
    let showDayView = () => {};
    let showYearView = () => {};
    let showMonthView = () => {};

    let closeAll = () => {};
    let triggerEl;

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
      const pop = wrap.querySelector('.qdp-pop');
      const dayView = wrap.querySelector('.qdp-dayview');
      const grid = wrap.querySelector('.qdp-grid');
      const monthLabel = wrap.querySelector('.qdp-month-label');
      const yearView = wrap.querySelector('.qdp-yearview');
      const yearGrid = wrap.querySelector('.qdp-yeargrid');
      const monthView = wrap.querySelector('.qdp-monthview');
      const monthGrid = wrap.querySelector('.qdp-monthgrid');
      const backYearLabel = wrap.querySelector('.qdp-back-year');

      function positionPop() {
        pop.style.left = '0'; pop.style.right = 'auto';
        const rect = pop.getBoundingClientRect();
        if (rect.right > window.innerWidth - 8) { pop.style.left = 'auto'; pop.style.right = '0'; }
      }
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
        pop.classList.add('open');
        triggerEl.classList.add('open');
        showDayView();
        positionPop();
      }
      function close() { pop.classList.remove('open'); triggerEl.classList.remove('open'); }
      closeAll = close;
      triggerEl.addEventListener('click', (e) => { e.stopPropagation(); pop.classList.contains('open') ? close() : open(); });
      pop.querySelectorAll('[data-nav]').forEach((btn) => btn.addEventListener('click', (e) => { e.stopPropagation(); viewDate.setMonth(viewDate.getMonth() + Number(btn.dataset.nav)); buildCalendarGrid(grid, monthLabel); }));
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
      wrap.querySelector('.qdp-back').addEventListener('click', (e) => { e.stopPropagation(); showYearView(); });
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
        wrap.remove();
        input.style.display = '';
        delete input._qlinicDatePicker;
      },
    };
    input._qlinicDatePicker = api;
    return api;
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

  function todayDateStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
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

  async function getClinic() {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return null;
    if (currentClinic && currentClinic.id === clinicId) return currentClinic;
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
    const { error } = await sb.from('clinics').update(payload).eq('id', clinicId);
    if (error) throw error;
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

  async function addDoctor({ name, specialty, feeNormal, feeEmergency, hprId }) {
    const clinicId = await ensureClinicContext();
    const { data, error } = await sb.from('doctors').insert({
      clinic_id: clinicId, name, specialty: specialty || '',
      fee_normal: feeNormal || 0, fee_emergency: feeEmergency || 0,
      hpr_id: hprId || null,
    }).select().single();
    if (error) throw error;
    return normalizeDoctor(data);
  }

  async function updateDoctor(doctorId, { name, specialty, feeNormal, feeEmergency, hprId }) {
    const { error } = await sb.from('doctors').update({
      name, specialty: specialty || '',
      fee_normal: feeNormal || 0, fee_emergency: feeEmergency || 0,
      hpr_id: hprId || null,
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

  async function searchBookedPatients(query) {
    const clinicId = await ensureClinicContext();
    const q = query.trim();
    if (!q || !clinicId) return [];
    const today = todayDateStr();
    const doctors = await getDoctors();
    const doctorById = Object.fromEntries(doctors.map((d) => [d.id, d]));
    const { data, error } = await sb
      .from('patients')
      .select('*')
      .eq('clinic_id', clinicId)
      .in('status', ['booked', 'waiting', 'no_show'])
      .eq('token_date', today)
      .or(`name.ilike.%${q}%,phone.ilike.%${q}%`);
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

  async function markArrived(patientId) {
    const { error } = await sb.from('patients').update({ status: 'waiting', arrived_at: new Date().toISOString() }).eq('id', patientId);
    if (error) throw error;
  }

  async function markNoShow(patientId) {
    const { error } = await sb.from('patients').update({ status: 'no_show' }).eq('id', patientId);
    if (error) throw error;
  }

  async function addWalkIn(info) {
    const clinicId = await ensureClinicContext();
    const { data, error } = await sb.from('patients').insert({
      clinic_id: clinicId,
      doctor_id: info.doctorId,
      name: info.name,
      phone: info.phone,
      address: info.address || '',
      age: info.age || null,
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
      age: info.age || null,
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
      .from('patients')
      .select('name, phone, age, gender, address, doctor_id, token_date, status, created_at')
      .eq('clinic_id', clinicId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
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

  async function getBillingPatientLookup(phone, dateStr) {
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
      const { data: todayPatient, error: patientErr } = await sb.from('patients')
        .select('id, doctor_id')
        .eq('clinic_id', clinicId).eq('phone', cleanPhone).eq('token_date', targetDateStr)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (patientErr) throw patientErr;
      if (todayPatient) {
        todayDoctorId = todayPatient.doctor_id;
        todayPatientId = todayPatient.id;
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
            .select('id, doctor_id, token_date')
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
            unbilledVisit = candidates.find((c) => !billedIds.has(c.id)) || null;
          }
        } catch (e) { }

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
    } catch (e) { }

    if (!patient && !invoice && !todayDoctorId && !mostRecentDoctorId) return null;
    return {
      name: (patient && patient.name) || (invoice && invoice.patient_name) || '',
      address: (patient && patient.address) || (invoice && invoice.patient_address) || '',
      gender: (patient && patient.gender) || (invoice && invoice.patient_gender) || '',
      age: (patient && patient.age) || (invoice && invoice.patient_age) || null,
      mostRecentDoctorId,
      mostRecentFeeType,
      mostRecentVisitDate,
      todayDoctorId,
      todayPatientId,
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
      p_patient_age: patientAge || null,
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
    const { data, error } = await sb.from('invoices').select('*')
      .eq('clinic_id', clinicId)
      .eq('invoice_date', dateStr)
      .eq('invoice_type', 'consultation')
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data.map(normalizeInvoice);
  }

  async function getTodayInvoices() {
    return getInvoicesForDate(todayDateStr());
  }

  async function getInvoicesForDateRange(startDateStr, endDateStr) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    const { data, error } = await sb.from('invoices').select('*')
      .eq('clinic_id', clinicId)
      .gte('invoice_date', startDateStr)
      .lte('invoice_date', endDateStr)
      .eq('invoice_type', 'consultation')
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data.map(normalizeInvoice);
  }

  async function getOutstandingInvoices() {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
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
    let query = sb.from('patients').select('*')
      .eq('clinic_id', clinicId)
      .gte('token_date', startDateStr)
      .lte('token_date', endDateStr);
    if (doctorId) query = query.eq('doctor_id', doctorId);
    const { data, error } = await query;
    if (error) throw error;
    return data.map(normalizePatient);
  }

  async function getNoShowsForDate(dateStr) {
    return getNoShowsForDateRange(dateStr, dateStr);
  }
  async function getNoShowsForDateRange(startDateStr, endDateStr) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    const { data, error } = await sb.from('patients').select('*')
      .eq('clinic_id', clinicId)
      .eq('status', 'no_show')
      .gte('token_date', startDateStr)
      .lte('token_date', endDateStr);
    if (error) throw error;
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

  async function queueBookingNotification({ patientId, phone, doctorId, kind, bookedDate, bookedTime, tokenNumber }) {
    try {
      const clinicId = await ensureClinicContext();
      const [clinic, doctor] = await Promise.all([getClinic(), getDoctor(doctorId)]);
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
      const { error } = await sb.from('patients').update(updatePayload).eq('id', current.id);
      if (error) throw error;
    }
    const waiting = mine.filter((p) => p.status === 'waiting').sort((a, b) => compareQueueOrder(a, b, doctor));
    if (waiting.length === 0) return { called: false };
    const { error } = await sb.from('patients').update({ status: 'in_consult', called_at: new Date().toISOString() }).eq('id', waiting[0].id);
    if (error) throw error;
    return { called: true };
  }

  async function finishCurrentPatient(doctorId) {
    const today = todayDateStr();
    const mine = await fetchPatientsForDoctorAndDate(doctorId, today);
    const current = mine.find((p) => p.status === 'in_consult');
    if (current) {
      const doneAt = new Date();
      const updatePayload = { status: 'done', done_at: doneAt.toISOString() };
      if (current.calledAt) {
        updatePayload.consultation_duration_seconds = Math.max(0, Math.round((doneAt.getTime() - new Date(current.calledAt).getTime()) / 1000));
      }
      const { error } = await sb.from('patients').update(updatePayload).eq('id', current.id);
      if (error) throw error;
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

  async function findNextAvailableSlot(doctorId, dateStr, fromTimeStr) {
    const clinic = await getClinic();
    let bucket = bucketStartMinutes(fromTimeStr, clinic.slot_interval_mins);
    for (let i = 0; i < 48; i++) {
      const count = await countActiveAtSlot(doctorId, dateStr, formatHHMM(bucket));
      if (count < clinic.slot_capacity) return formatHHMM(bucket);
      bucket += clinic.slot_interval_mins;
    }
    return formatHHMM(bucket);
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
      rows.forEach((r) => {
        if (!r.booked_time) { noTimeCount += 1; return; }
        const mins = parseTime(r.booked_time.slice(0, 5));
        const bucket = buckets.find((b) => mins >= b.start && mins < b.end) || buckets[buckets.length - 1];
        if (bucket) bucket.count += 1;
      });
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
    const closed = new Date(doctor.dayClosedAt);
    const y = closed.getFullYear();
    const m = String(closed.getMonth() + 1).padStart(2, '0');
    const d = String(closed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}` === todayDateStr();
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
      myProfilePromise = (async () => {
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return null;
        const { data, error } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
        if (error) throw error;
        return data ? normalizeProfile(data) : null;
      })();
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
    const { data, error } = await tempClient.auth.signUp({ email, password });
    if (error) throw error;
    const { error: linkError } = await sb.rpc('create_staff_profile', {
      new_user_id: data.user.id,
      staff_email: email,
      staff_full_name: fullName,
      staff_role: role,
      staff_doctor_id: role === 'doctor' ? (doctorId || null) : null,
      staff_phone: phone || null,
    });
    if (linkError) throw linkError;
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
    for (const [id, key] of Object.entries(FEATURE_NAV_MAP)) {
      const el = document.getElementById(id);
      if (el && !(await hasFeature(key))) el.style.display = 'none';
    }
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

  async function onLiveChange(cb) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return;
    let debounceTimer = null;
    function debouncedCb(payload) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => cb(payload), 300);
    }
    sb.channel('clinic-' + clinicId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'patients', filter: `clinic_id=eq.${clinicId}` }, debouncedCb)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'doctors', filter: `clinic_id=eq.${clinicId}` }, debouncedCb)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'doctor_holidays', filter: `clinic_id=eq.${clinicId}` }, debouncedCb)
      .subscribe();
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
    let query = sb.from('medicines').select('*').eq('clinic_id', clinicId);
    if (activeOnly) query = query.eq('is_active', true);
    if (search) query = query.ilike('name', `%${search}%`);
    const { data, error } = await query.order('name');
    if (error) throw error;
    return data.map(normalizeMedicine);
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
    const { data, error } = await sb.rpc('create_pharmacy_invoice', {
      p_patient_id: patientId || null,
      p_patient_name: patientName || '',
      p_patient_phone: patientPhone || '',
      p_payment_mode: paymentMode || 'cash',
      p_amount_received: amountReceived == null ? null : Number(amountReceived),
      p_items: items.map((i) => ({ medicine_id: i.medicineId, quantity: Number(i.quantity) })),
    });
    if (error) throw error;
    return normalizeInvoice(data);
  }

  async function searchPatientsForPharmacy(query) {
    const clinicId = await ensureClinicContext();
    const q = (query || '').trim();
    if (!q || !clinicId) return [];
    const { data, error } = await sb
      .from('patients')
      .select('id, name, phone')
      .eq('clinic_id', clinicId)
      .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    const seenPhones = new Set();
    const results = [];
    for (const row of data) {
      const phone = (row.phone || '').trim();
      if (phone && seenPhones.has(phone)) continue;
      if (phone) seenPhones.add(phone);
      results.push({ id: row.id, name: row.name, phone: row.phone });
      if (results.length >= 20) break;
    }
    return results;
  }

  async function getInvoiceItems(invoiceId) {
    const { data, error } = await sb.from('invoice_items').select('*').eq('invoice_id', invoiceId).order('created_at');
    if (error) throw error;
    return data.map(normalizeInvoiceItem);
  }

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
    confirmDialog,
    openAdjustBillingModal,
    attachDatePicker,
    getQueueStatus,
    submitProductFeedback,

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

    onLiveChange,
  };
})(window);
