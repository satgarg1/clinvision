/**
 * Qlinic: real backend client, backed by Supabase (Postgres + Auth +
 * Realtime). Replaces the old data.js, which stored everything in
 * localStorage as a stand-in for a real database.
 *
 * Exposes the same window.Qlinic global with mostly the same function
 * names as before, so the page-level code changes are additive
 * (mainly: await the calls, since these now hit the network) rather
 * than a rewrite. See supabase/schema.sql for the database side.
 */
(function (global) {
  if (!window.SUPABASE_URL || window.SUPABASE_URL.indexOf('YOUR-PROJECT-REF') !== -1) {
    console.error('Qlinic: fill in clinic-config.js with your real Supabase project URL and anon key.');
  }

  const sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

  let currentClinicId = null;
  let currentClinic = null;

  // Patient/doctor names, addresses, and other free text are typed by
  // clinic staff (or, for a booking's own reason field, indirectly by
  // whoever asked them to write it down) and then get interpolated into
  // innerHTML template strings all over the app to build tables, cards,
  // and the public display/queue screens. None of that text was ever
  // escaped, so a name containing HTML would be parsed as markup on
  // every page that shows it — including queue.html and display.html,
  // which have no login at all. Shared here so every page uses the same
  // one function rather than each re-implementing it slightly differently.
  //
  // Escapes quotes too, not just &/</>: several call sites use this
  // inside value="${...}" (editable table rows), where a raw " would
  // close the attribute early and let anything after it — including a
  // new onXXX="..." attribute — get parsed as a live event handler.
  // textContent-via-a-detached-div only escapes &/</> (correct for a
  // text node, not for an attribute value), so quotes are handled
  // manually on top of that.
  function escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Every confirmation in the app used to be window.confirm() — a native
  // browser dialog with no styling hook at all (unlike everything else
  // here, it's drawn by the browser itself, outside the page's DOM).
  // This is the shared replacement: one dynamically-injected modal that
  // every page calls the same way. Resolves true/false instead of
  // returning synchronously, so every call site becomes
  // `if (await Qlinic.confirmDialog({...}))` in place of `if (confirm(...))`.
  // Real confirm/cancel labels (not a fixed "OK"/"Cancel") let a call site
  // spell out exactly what each button does, which matters most for the
  // handful of dialogs where OK/Cancel used to carry specific, opposite
  // meanings spelled out awkwardly inside the message text itself.
  function confirmDialog({ title, message, confirmLabel = 'Continue', cancelLabel = 'Cancel', danger = false } = {}) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal-card" role="alertdialog" aria-modal="true">
          ${title ? `<h2 class="modal-title">${escapeHtml(title)}</h2>` : ''}
          <p class="modal-message">${escapeHtml(message)}</p>
          <div class="modal-actions">
            <button type="button" class="btn-sm" id="modalCancelBtn">${escapeHtml(cancelLabel)}</button>
            <button type="button" class="btn-sm ${danger ? 'danger-solid' : 'primary'}" id="modalConfirmBtn">${escapeHtml(confirmLabel)}</button>
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
      // A destructive action's Cancel gets focus, not its Confirm — so
      // hitting Enter/Space right after the dialog opens (a reflexive
      // dismiss, or focus arriving from whatever was just clicked)
      // backs out instead of completing the destructive action.
      backdrop.querySelector(danger ? '#modalCancelBtn' : '#modalConfirmBtn').focus();
    });
  }

  // ---------------- custom date picker, replacing the bare native
  // <input type="date"> everywhere it shows up: a trigger showing the
  // picked date + Today/Tomorrow/In-a-week quick picks above a
  // calendar. (A second "week strip" variant was mocked up and tried
  // for the always-reopened filters, but didn't land — every field
  // uses this one shape now.)
  //
  // Hides the real <input> (kept in the DOM, not removed) rather than
  // replacing it, so every existing call site — .value reads/writes,
  // .min/.max/.required, 'change' listeners, validation .focus() calls
  // — keeps working completely unmodified. A property override on the
  // element's own .value catches every future assignment (not just
  // ones made through this widget), so code that sets the date
  // programmatically after this runs still stays in sync.
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
    // .min/.max are read fresh every time, not cached at attach time —
    // reception sets pDate.min only after this runs, so caching it here
    // would silently ignore that constraint forever.
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

    let closeAll = () => {};
    let triggerEl;

    {
      wrap.innerHTML = `
        <button type="button" class="qdp-trigger">
          <span class="qdp-trigger-label"></span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>
        </button>
        <div class="qdp-pop">
          <div class="qdp-quick">
            <button type="button" data-quick="0">Today</button>
            <button type="button" data-quick="1">Tomorrow</button>
            <button type="button" data-quick="7">In a week</button>
          </div>
          <div class="qdp-head">
            <span class="qdp-month-label"></span>
            <div class="qdp-nav"><button type="button" data-nav="-1" title="Previous month" aria-label="Previous month">‹</button><button type="button" data-nav="1" title="Next month" aria-label="Next month">›</button></div>
          </div>
          <div class="qdp-dow"><span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span></div>
          <div class="qdp-grid"></div>
        </div>
      `;
      triggerEl = wrap.querySelector('.qdp-trigger');
      const pop = wrap.querySelector('.qdp-pop');
      const grid = wrap.querySelector('.qdp-grid');
      const monthLabel = wrap.querySelector('.qdp-month-label');

      function positionPop() {
        pop.style.left = '0'; pop.style.right = 'auto';
        const rect = pop.getBoundingClientRect();
        if (rect.right > window.innerWidth - 8) { pop.style.left = 'auto'; pop.style.right = '0'; }
      }
      function open() {
        document.querySelectorAll('.qdp-pop.open').forEach((p) => { if (p !== pop) p.classList.remove('open'); });
        pop.classList.add('open');
        triggerEl.classList.add('open');
        buildCalendarGrid(grid, monthLabel);
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
      pop.addEventListener('click', (e) => e.stopPropagation());
      document.addEventListener('click', close);

      function updateLabel() {
        wrap.querySelector('.qdp-trigger-label').textContent = selected ? fmtShort(selected) : (opts.placeholder || 'Pick a date');
        wrap.querySelector('.qdp-trigger-label').classList.toggle('qdp-placeholder', !selected);
        pop.querySelectorAll('[data-quick]').forEach((btn) => {
          const d = startOfDay(new Date()); d.setDate(d.getDate() + Number(btn.dataset.quick));
          // A field capped at today (a historical filter — can't pull
          // revenue that hasn't happened yet) has no honest way to offer
          // "Tomorrow"/"In a week" - hidden rather than left clickable
          // and silently doing nothing.
          btn.style.display = isDisabled(d) ? 'none' : '';
          btn.classList.toggle('selected', !!selected && sameDay(d, selected));
        });
      }
      var updateLabelFn = updateLabel;
    }

    // Every date change (chip pick, calendar click, or a plain code
    // assignment via the .value override below) always funnels through
    // here.
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
    // A native date input auto-selects its first segment on focus (a
    // stray blue-highlighted day number) — focusing the visible trigger
    // instead is both the fix and the only thing "focus the date field"
    // can sensibly mean once the real input is hidden.
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

  // ---------------- time-of-day helpers (unchanged from the old data.js:
  // these operate on "HH:MM" strings like <input type="time"> values, not
  // on real timestamps, so they don't need to change just because the
  // backend did). ----------------
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

  // ---------------- real-timestamp helpers (new: this is what replaces
  // the simulated clinic clock) ----------------
  function formatTimestamp(value) {
    if (!value) return '·';
    const date = value instanceof Date ? value : new Date(value);
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  // Date + time together, for records like an invoice where "when" matters
  // as much as "what time" (formatTimestamp above only shows the time).
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

  // ---------------- queue-ordering logic ----------------
  // Every patient — walk-in or appointment — has an "intended moment":
  // an appointment's booked slot, or (for walk-ins) either the moment
  // they checked in, or a later time staff assigned them if the desk
  // was too busy to see them right away. bookedDate/bookedTime being
  // present is what distinguishes "has a real intended time" now,
  // rather than patient.type — a walk-in given an explicit time flows
  // through the exact same formula as an appointment.
  function intendedMoment(patient) {
    if (patient.bookedDate && patient.bookedTime) {
      return new Date(`${patient.bookedDate}T${patient.bookedTime}`);
    }
    return patient.arrivedAt ? new Date(patient.arrivedAt) : new Date();
  }

  // The doctor genuinely cannot see anyone before they're back from a
  // declared delay — this clamps ANY patient's intended moment forward
  // to that point, not just appointments, so a walk-in arriving mid-
  // break can't leapfrog patients who were already due before the
  // doctor stepped away. Only active while a delay is actually in
  // effect (delayMins > 0): clearing status or going to emergency
  // always resets delayMins to 0 (see setDoctorStatus), so this is
  // naturally inert the rest of the time — no separate on/off branch
  // needed. The already-arrived floor below is unchanged from before,
  // now just applied uniformly to both types.
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

  // Priority patients always go first, full stop — a true emergency
  // bypasses time-based ordering entirely rather than being modeled as
  // "an early time." Otherwise: the doctor-availability-aware effective
  // moment governs, with each patient's own unclamped intended moment
  // as the tiebreak for patients bunched at the same delay floor (so
  // someone due earlier keeps priority even when a break pins several
  // patients to the same "available again" instant), and row-creation
  // order as a purely technical last-resort for a genuine coincidence
  // (same intended moment, same doctor) — never token number, which
  // only reflects booking order and has no relationship to when
  // someone is actually due to be seen.
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

  // All 28 states + 8 union territories, for a dropdown rather than free
  // text — auto-fill from the pincode API still writes into this same
  // field (see lookupCityStateForPincode below); the dropdown is what
  // lets someone fix it with a couple clicks if the API guesses wrong.
  const INDIA_STATES_AND_UTS = [
    'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar',
    'Chandigarh', 'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa',
    'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka',
    'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
    'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
    'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  ];

  // ---------------- pincode lookup (for clinic address auto-fill) ----------------

  // A hand-maintained prefix table can't actually resolve this correctly
  // (adjacent pincodes like 247001/Saharanpur/UP and 247667/Roorkee/
  // Uttarakhand share the same 3-digit prefix but are different states),
  // so this calls India Post's own public pincode API instead of
  // guessing. Free, no key, no auth. City is the post office's district
  // (there's no separate "city" concept in India Post's data — District
  // is the closest single value shared across every post office under
  // that pincode). Any failure (offline, API down, unknown pincode)
  // resolves both fields to '' — City/State stay normal editable inputs
  // either way, so a miss is a one-click fix, not a blocker.
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

  // ---------------- clinic / auth context ----------------

  async function ensureClinicContext() {
    if (currentClinicId) return currentClinicId;
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;
    const { data, error } = await sb.from('profiles').select('clinic_id').eq('id', session.user.id).maybeSingle();
    if (error) throw error;
    currentClinicId = data ? data.clinic_id : null;
    return currentClinicId;
  }

  // If a user confirmed their email (or confirmation is off and they got
  // a session immediately) but has no profile/clinic yet, the clinic name
  // they typed at signup time is sitting in their auth user_metadata,
  // finish creating their clinic automatically instead of asking again.
  async function finishClinicSetupIfNeeded(session) {
    const { data: existing, error } = await sb.from('profiles').select('clinic_id').eq('id', session.user.id).maybeSingle();
    if (error) throw error;
    if (existing) { currentClinicId = existing.clinic_id; return; }
    const pendingName = session.user.user_metadata && session.user.user_metadata.pending_clinic_name;
    if (pendingName) {
      const { data: clinicId, error: rpcError } = await sb.rpc('register_clinic', { clinic_name: pendingName });
      if (rpcError) throw rpcError;
      currentClinicId = clinicId;
      // The address was collected at signup but the clinic row (and this
      // user's admin profile, which "update own clinic" RLS checks) only
      // exists from this point on, so it's applied here rather than at
      // signUp() time — covers both the immediate-session path and the
      // email-confirmation path, where this runs on first login instead.
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

  // fields: { name, graceWindowMins, slotIntervalMins, slotCapacity }, any
  // subset. Used by the Settings page for clinic profile + queue rules.
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
    currentClinic = null; // force a fresh read next time
  }

  // ---------------- clinic logo ----------------

  const LOGO_BUCKET = 'clinic-logos';
  const MAX_LOGO_BYTES = 2 * 1024 * 1024;

  // One fixed path per clinic ("{clinicId}/logo", no extension — the
  // content-type is set explicitly below, so the extension isn't needed
  // for the browser to render it correctly) — a re-upload always
  // overwrites the same file rather than accumulating orphaned ones for
  // clinics that change their logo more than once.
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
    // Cache-busted so a changed logo shows immediately instead of
    // whatever the browser cached for the previous file at this same path.
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

  // ---------------- clinic closures (one-off closed dates) ----------------

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

  // ---------------- doctor holidays (per-doctor leave dates) ----------------

  function normalizeDoctorHoliday(row) {
    return { id: row.id, doctorId: row.doctor_id, date: row.holiday_date, note: row.note || '' };
  }

  // Omit doctorId for every doctor's holidays clinic-wide (reception's
  // booking-time lookup); pass it to scope to one doctor's own list.
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

  // Defaults to active doctors only: that's what every operational screen
  // (reception, doctor view, dashboard, display) should ever see. Settings
  // passes { includeInactive: true } since it's the one place that needs to
  // manage doctors who've been deactivated too.
  async function getDoctors(opts) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    let query = sb.from('doctors').select('*').eq('clinic_id', clinicId);
    if (!(opts && opts.includeInactive)) query = query.eq('is_active', true);
    const { data, error } = await query.order('created_at');
    if (error) throw error;
    return data.map(normalizeDoctor);
  }

  // A single targeted row, not the whole table filtered down in JS — this
  // used to call getDoctors() (every doctor in the clinic) just to find
  // one by id, which turned any per-doctor loop (getQueueForDoctor across
  // all doctors, called on every queue render) into that many redundant
  // full-table fetches.
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

  // Deactivating (not deleting) a doctor: see supabase/002_doctor_active_flag.sql
  // for why: patients.doctor_id cascades on delete, so a hard delete would
  // wipe that doctor's entire patient history.
  async function setDoctorActive(doctorId, isActive) {
    const { error } = await sb.from('doctors').update({ is_active: isActive }).eq('id', doctorId);
    if (error) throw error;
  }

  // ---------------- patient queries ----------------

  // Filtering by token_date directly in the query (rather than fetching
  // broadly and filtering client-side) is what actually scopes this to
  // one day: token_date is set correctly for both walk-ins and
  // appointments at booking time, so this correctly includes walk-ins
  // on past-date views too, not just today's.
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

  // Returns { nowServing, waiting: [...with .position/.effectiveTime],
  // booked: [...with .effectiveTime], done, noShow }.
  // Defaults to today; pass a dateStr to browse a different day.
  // doctorHint (optional): skips the getDoctor() lookup when the caller
  // already has the doctor object in hand — e.g. looping every doctor's
  // queue via Promise.all(doctors.map(...)), where re-fetching each one
  // individually is a redundant round-trip per doctor for data the caller
  // already loaded to build that same loop.
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

  // Searches today's queue entries: booked (hasn't arrived — "mark
  // arrived" applies), waiting (already checked in — here so a typo in
  // their name/phone can still be fixed), or no_show (finalized by
  // End of day closing, but still findable so reception can revive a
  // late arrival — set a real effective time via Edit — without
  // re-entering them as a brand-new walk-in). token_date (not
  // booked_date, which is always null for a walk-in that was never
  // given an intended time) is the field that's reliably set across
  // every one of these.
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
    }));
  }

  // Fixes a mistake caught after a patient was already added, and also
  // powers Reception's "Edit" time-editor (a walk-in/appointment/no_show
  // row's bookedTime can be corrected the same way, setting a real
  // effective queue time for a late arrival or a revived no-show) — used
  // from Reception's search results, not part of the normal add-patient
  // flow. doctorId can be corrected for any patient; token_date is kept
  // mirrored to bookedDate whenever that's given, since token_date is
  // the field every other query filters by.
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

  // bookedTime is optional — most walk-ins stay "as soon as possible"
  // (no bookedDate/bookedTime, exactly as before), but reception can
  // give a busy-desk walk-in a specific later time instead, so they
  // flow through the same doctor-availability-aware ordering as an
  // appointment rather than always racing to the front by raw arrival.
  // isPriority is the true-emergency override, bypassing time-based
  // ordering entirely.
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

  // Looks up a phone number against past visits in this clinic, so
  // reception can reuse a returning patient's details instead of
  // retyping them, and see if they've been missing appointments. Exact
  // phone match only, no attempt to normalize spacing/formatting.
  async function getPatientLookupByPhone(phone) {
    const clinicId = await ensureClinicContext();
    const cleanPhone = (phone || '').trim();
    if (!clinicId || !cleanPhone) return null;
    const { data, error } = await sb
      .from('patients')
      .select('name, gender, address, age, status')
      .eq('clinic_id', clinicId)
      .eq('phone', cleanPhone)
      .order('created_at', { ascending: false })
      .limit(5);
    if (error) throw error;
    if (!data || data.length === 0) return null;
    const latest = data[0];
    return {
      name: latest.name,
      gender: latest.gender,
      address: latest.address,
      age: latest.age,
      visitsChecked: data.length,
      noShowCount: data.filter((p) => p.status === 'no_show').length,
    };
  }

  // A clinic-wide, deduplicated-by-phone directory of everyone who has
  // actually been seen at least once (same waiting/in_consult/done
  // footfall definition used everywhere else in the app) — built for
  // admin reference (record-keeping, reporting), not day-to-day queue
  // work, so unlike the rest of the app it isn't scoped to any date
  // range: it fetches the clinic's entire patient history at once.
  //
  // Phone number is the only practical dedup key available (no email or
  // ID is collected): a shared family phone will merge into one row,
  // and a different number on a later visit will show up as a separate
  // one. A phone whose only rows are 'booked'/'no_show' (never actually
  // arrived) is left out entirely — that's a booking attempt, not
  // patient history.
  async function getPatientDirectory() {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    const { data, error } = await sb
      .from('patients')
      .select('name, phone, age, gender, address, doctor_id, token_date, status, created_at')
      .eq('clinic_id', clinicId)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const byPhone = {};
    (data || []).forEach((row) => {
      const phone = (row.phone || '').trim();
      if (!phone) return;
      (byPhone[phone] = byPhone[phone] || []).push(row);
    });

    const directory = [];
    Object.entries(byPhone).forEach(([phone, rows]) => {
      const visited = rows.filter((r) => ['waiting', 'in_consult', 'done'].includes(r.status));
      if (visited.length === 0) return;
      const latest = rows[0]; // rows inherit the query's created_at-desc order within each group
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
    });

    return directory;
  }

  // Follow-up fee waiver check: does this patient's most recent
  // COMPLETED visit with this exact doctor fall within the clinic's
  // configured follow-up window (Settings -> Queue rules)? Anchored to
  // the last 'done' visit specifically, not any booking attempt — a
  // no-show doesn't extend or preserve the free-visit window, since as
  // far as eligibility is concerned they never actually came in.
  //
  // Returns null when there's nothing worth telling reception: the
  // feature is off (bufferDays 0), or this patient has no prior
  // completed visit with this doctor at all (first-time patient, the
  // normal fee applies with nothing special to flag).
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

  // ---------------- billing ----------------

  // Patients here are per-visit rows (see getPatientLookupByPhone
  // above), not one canonical profile, so this takes age from the most
  // recent booking (Reception's own "age" field), falling back to the
  // most recent invoice's age for patients billed before that field
  // existed.
  async function getBillingPatientLookup(phone, dateStr) {
    const clinicId = await ensureClinicContext();
    const cleanPhone = (phone || '').trim();
    if (!clinicId || !cleanPhone) return null;

    // Patients and invoices are looked up independently: neither should
    // be able to sink the other. A clinic with no invoices yet (or a
    // migration that hasn't run) must not break the name/address/gender
    // autofill that's been working since Reception's own phone lookup,
    // and vice versa.
    let patient = null;
    try {
      const { data, error } = await sb.from('patients').select('name, gender, address, age')
        .eq('clinic_id', clinicId).eq('phone', cleanPhone)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      patient = data;
    } catch (e) { /* best-effort */ }

    let invoice = null;
    try {
      const { data, error } = await sb.from('invoices').select('patient_name, patient_address, patient_age, patient_gender')
        .eq('clinic_id', clinicId).eq('patient_phone', cleanPhone)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      invoice = data;
    } catch (e) { /* best-effort */ }

    // A visit on the SELECTED billing date specifically (not just "most
    // recent ever") is what makes doctor/fee-type autofill trustworthy —
    // pairing a patient with whichever doctor they saw months ago would
    // be actively wrong more often than it'd help. Defaults to today when
    // the caller doesn't pass a date, matching billing-consultation.html's
    // own date field default; passing a backdated date here is what makes
    // that field's autofill actually look up the right day's visit. If
    // they've seen more than one doctor that day, this picks whichever
    // visit was created most recently; the caller's "double-check before
    // printing" hint is the guard against that edge case rather than
    // trying to disambiguate it here.
    let todayDoctorId = null;
    let todayFeeType = null;
    let todayInvoiceId = null;
    let todayPaymentMode = null;
    let todayAmountReceived = null;
    // Populated only when there's no visit on the selected date at all —
    // the fallback that lets a returning patient's most recent doctor/fee
    // type/date autofill instead of leaving reception to pick everything
    // from scratch just because the billing date field doesn't happen to
    // match their last visit. Always freely editable afterward either way.
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
        // Fee type only exists once they're actually billed (e.g. the
        // auto-invoice-on-arrival trigger already ran); a booked-but-not-
        // arrived visit has a doctor but no fee type yet, left for
        // reception to pick. todayInvoiceId is what lets the caller
        // correct THIS invoice (fee type, payment mode, amount) instead of
        // creating a second one for the same visit — see
        // billing-consultation.html's submit handler.
        const { data: todayInvoice, error: invoiceErr } = await sb.from('invoices')
          .select('id, fee_type, payment_mode, amount_received')
          .eq('clinic_id', clinicId).eq('patient_id', todayPatient.id)
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (invoiceErr) throw invoiceErr;
        if (todayInvoice) {
          todayFeeType = todayInvoice.fee_type;
          todayInvoiceId = todayInvoice.id;
          todayPaymentMode = todayInvoice.payment_mode;
          todayAmountReceived = todayInvoice.amount_received;
        }
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
            .eq('clinic_id', clinicId).eq('patient_id', recentPatient.id)
            .order('created_at', { ascending: false }).limit(1).maybeSingle();
          if (recentInvErr) throw recentInvErr;
          mostRecentFeeType = recentInvoice ? recentInvoice.fee_type : null;
        }
      }
    } catch (e) { /* best-effort */ }

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
      amountReceived: Number(row.amount_received),
      createdAt: row.created_at,
      invoiceDate: row.invoice_date,
    };
  }

  // Consultation billing's manual form (unlike the auto-billed-on-arrival
  // path in 016, which always links straight to a real patients row) has
  // no built-in tie to an actual visit — it's just typed fields, so
  // nothing stopped a bill being created for a phone number that never
  // showed up in the queue at all on that date. token_date already
  // mirrors "which day this patient belongs to" for both walk-ins and
  // appointments (see getPatientsInRange), so it's the same field to
  // check here: does ANY patient row for this clinic have this phone and
  // this token_date, regardless of status (a no-show or already-finished
  // visit still proves the appointment existed).
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

  async function createInvoice({ doctorId, feeType, patientName, patientPhone, patientAddress, patientAge, patientGender, paymentMode, amountReceived, invoiceDate }) {
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
    });
    if (error) throw error;
    return normalizeInvoice(data);
  }

  // Auto-billed invoices (see migration 016) never come through
  // createInvoice at all — the database creates them itself the moment
  // a patient's status becomes "waiting". This is how Reception finds
  // out which of today's queued patients already got billed, so it
  // can show the auto-billed status instead of prompting anyone to
  // re-enter it.
  // invoice_date (migration 024) is a plain date column, not a
  // timestamp — it's "which day this bill is for," editable on the
  // billing form and separate from created_at's role as an honest audit
  // timestamp of when the row was actually inserted. A straight equality/
  // range filter here, no local-time-boundary conversion needed (that
  // was only ever a workaround for created_at being a timestamptz).
  async function getInvoicesForDate(dateStr) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    const { data, error } = await sb.from('invoices').select('*')
      .eq('clinic_id', clinicId)
      .eq('invoice_date', dateStr)
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
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data.map(normalizeInvoice);
  }

  // token_date is a plain date column (not a timestamp), so a range filter
  // here doesn't need the local-time-boundary conversion getInvoicesForDate
  // needs for created_at.
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

  // Same token_date field, same range-filter shape as getPatientsInRange —
  // just narrowed to status='no_show', which only ever happens to a
  // 'booked' appointment closeDayNoShows() never saw arrive by the time
  // the day was closed (walk-ins go straight to 'waiting' and can't reach
  // this status at all).
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

  // Server-side coverage check (get_billing_audit(), migration 045) -
  // computed in Postgres rather than fetched-and-checked client-side,
  // since confirming the invoice_number range is gap-free only needs a
  // count/min/max, not every invoice row over a clinic's whole history.
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

  // The correction path for an auto-billed invoice: wrong payment
  // method, an emergency fee, or a genuinely free visit ('waived',
  // which zeroes the amount). Never required, only used for the
  // exceptions — see update_invoice_payment() in migration 016 for why
  // the amount still isn't trusted from the client even here.
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

  // ---------------- patient notifications ----------------
  // The tech for "text the patient their appointment time," built without
  // a live SMS provider connected. Every booking composes a message and
  // logs it as 'pending' in the notifications table; nothing is actually
  // delivered yet. Wiring up a real provider later means adding a
  // Supabase Edge Function that processes pending rows and flips them to
  // sent/failed; the booking flow itself won't need to change.

  // The queue-status page lives next to whatever page is doing the
  // booking (reception.html today), so building the link off the
  // current page's own URL means this works on localhost, a staging
  // copy, or the real GitHub Pages site without any hardcoded domain.
  function queueLinkFor(patientId) {
    const dir = window.location.href.replace(/[^/]*$/, '');
    return `${dir}queue.html?id=${patientId}`;
  }

  // Composing the message needs the clinic's name and the doctor's name
  // and specialty; never lets a failure here block the booking itself,
  // since the SMS log is a nice-to-have, not the core action.
  async function queueBookingNotification({ patientId, phone, doctorId, kind, bookedDate, bookedTime, tokenNumber }) {
    try {
      const clinicId = await ensureClinicContext();
      const [clinic, doctor] = await Promise.all([getClinic(), getDoctor(doctorId)]);
      // Appointments and walk-ins are separate token sequences (see
      // migration 037) — a walk-in's raw number is offset by 100000, so
      // it needs the same "W"-prefixed display as everywhere else it's
      // shown, not the raw number.
      const tokenDisplay = tokenNumber ? (tokenNumber > 100000 ? 'W' + (tokenNumber - 100000) : '#' + tokenNumber) : null;
      const tokenLine = tokenDisplay ? ` Your token number is ${tokenDisplay}.` : '';
      const link = tokenNumber ? queueLinkFor(patientId) : '';
      const doctorLine = doctor.specialty ? `${doctor.name} (${doctor.specialty})` : doctor.name;

      let message;
      if (kind === 'appointment') {
        const dateLabel = formatDateLabel(bookedDate);
        const timeLabel = formatTime(parseTime(bookedTime));
        // A booking days out shouldn't invite "see the current token
        // being served" — there's no queue to see yet. Said plainly
        // instead, with the actual date, so no one clicks in early
        // expecting something and gets confused by queue.html's own
        // "not yet" screen (see showNotYet in queue.html).
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

  // ---------------- public queue lookup (Phase 1 of the live-queue
  // feature: no page reads this yet) ----------------
  // Anonymous, no login required; this is the client-side counterpart
  // to the get_queue_status() database function. Knowing a patient's own
  // id (an unguessable UUID) is what authorizes seeing this; the
  // function itself returns only a sanitized subset (never other
  // patients' names/phone numbers).
  async function getQueueStatus(patientId) {
    const { data, error } = await sb.rpc('get_queue_status', { p_patient_id: patientId });
    if (error) throw error;
    return data;
  }

  async function callNextPatient(doctorId) {
    const today = todayDateStr();
    // Independent fetches (neither needs the other's result) — run in
    // parallel instead of adding a full extra round-trip in front of the
    // app's single most-clicked button.
    const [doctor, mine] = await Promise.all([
      getDoctor(doctorId),
      fetchPatientsForDoctorAndDate(doctorId, today),
    ]);
    const current = mine.find((p) => p.status === 'in_consult');
    if (current) {
      await sb.from('patients').update({ status: 'done', done_at: new Date().toISOString() }).eq('id', current.id);
    }
    const waiting = mine.filter((p) => p.status === 'waiting').sort((a, b) => compareQueueOrder(a, b, doctor));
    if (waiting.length === 0) return { called: false };
    await sb.from('patients').update({ status: 'in_consult', called_at: new Date().toISOString() }).eq('id', waiting[0].id);
    return { called: true };
  }

  // Half of callNextPatient, deliberately: marks the current in-consult
  // patient done WITHOUT pulling the next waiting patient in. Used when a
  // doctor goes on a break or has an emergency right after finishing with
  // someone — they're stepping away, not ready to see anyone new, so
  // nothing should get pulled into the room. doctor.html's "Call next
  // patient" stays disabled the whole time regardless, so there's no
  // window where an empty in-consult slot could get auto-filled anyway.
  async function finishCurrentPatient(doctorId) {
    const today = todayDateStr();
    const mine = await fetchPatientsForDoctorAndDate(doctorId, today);
    const current = mine.find((p) => p.status === 'in_consult');
    if (current) {
      await sb.from('patients').update({ status: 'done', done_at: new Date().toISOString() }).eq('id', current.id);
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

  // ---------------- slot capacity ----------------

  // No type filter — a walk-in given a preferred time now competes for the
  // same slot as a phoned-in appointment, so it has to count against the
  // same capacity or reception could unknowingly double-book a slot that
  // only looked open because walk-ins were invisible to this check. A
  // walk-in with no preferred time has booked_time null and is correctly
  // excluded below (it was never assigned a slot to begin with).
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

  // windowStart/windowEnd expose the actual bucket a given time falls
  // into (see bucketStartMinutes) — "4 booked around this time" was
  // genuinely confusing when Queue Rules' slot length is narrower than
  // the reasonable-looking gap between two times a receptionist might
  // pick (e.g. 9:20 and 9:25 landing in the same 10-minute bucket).
  // Surfacing the real window turns that from a mystery into a visible
  // rule, without reception needing to know Queue Rules exists.
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

  // Single-query alternative to countActiveAtSlot/getSlotAvailability: those
  // check one proposed time against capacity right now, this shows the
  // WHOLE day's schedule — every patient who was ever placed at a given
  // time, regardless of what's since happened to them. No status filter:
  // an appointment finishes and moves to 'done' hours before the day is
  // over, and excluding it made that slot look like it had never been
  // booked at all, which is the opposite of what "today's schedule" means.
  // No type filter either — both formal appointments and walk-ins that
  // were given a preferred time share the same booked_time column.
  //
  // Filters on token_date, not booked_date: addWalkIn only sets booked_date
  // when a preferred time was given (clinic-data.js:~660) — a walk-in added
  // "as soon as possible" has booked_date AND booked_time both null.
  // token_date is set unconditionally for every patient regardless of
  // type, and equals booked_date for anyone it isn't null for — the same
  // field getPatientsInRange/getDailySummary/getPatientDirectory already
  // use as "which day this patient belongs to."
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

  // A read-only sibling of confirmDialog (same backdrop/card/cleanup
  // pattern) showing a bucketed count of a doctor's day. intervalMins is
  // the clinic's own configurable schedule_interval_mins (Settings), not
  // the slot_interval_mins that drives the single-slot hint/override flow
  // elsewhere — the two are intentionally independent. isToday controls
  // two things: past-elapsed buckets are dimmed (they're no longer a slot
  // reception could actually offer), and the dialog opens pre-scrolled to
  // the current bucket instead of the top of a full day's grid.
  function slotScheduleDialog({ doctorName, dateLabel, openMin, closeMin, intervalMins, rows, isToday }) {
    return new Promise((resolve) => {
      const nowMin = isToday ? (new Date().getHours() * 60 + new Date().getMinutes()) : null;
      const buckets = [];
      for (let start = openMin; start < closeMin; start += intervalMins) {
        buckets.push({ start, end: Math.min(start + intervalMins, closeMin), count: 0 });
      }
      // A walk-in added "as soon as possible" has no booked_time at all —
      // it was never assigned a slot to bucket. Surfaced as its own line
      // ABOVE the (scrollable) time grid, not inside it — a clinic where
      // most walk-ins go untimed showed an all-zero grid with the real
      // number buried below a screen's worth of empty rows.
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

  // A generic read-only table dialog, same backdrop/card/cleanup pattern
  // as slotScheduleDialog/confirmDialog — used by the Dashboard's stat
  // cards to break a clinic-wide number down per doctor. columns/rows are
  // plain strings; escaping happens here, not at each call site.
  // rowHrefs (optional): a URL per row (or null for that row), making it
  // a clickable drill-through into patient-breakdown.html instead of a
  // dead-end summary number. viewAllHref (optional): a single link
  // above the table for "every patient behind this metric, regardless
  // of doctor" — the row-level links stay doctor-scoped.
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

  // ---------------- daily summary / close day ----------------

  // doctorId is optional and scopes every count to just that doctor's own
  // patients — used for a doctor's own Dashboard view. Omitted, this stays
  // the clinic-wide summary every existing caller already relies on.
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

    // Computed from every doctor's patients regardless of the doctorId
    // filter above — this is what the dashboard's per-doctor breakdown
    // popups read, which only make sense clinic-wide even when the
    // top-line numbers themselves are scoped to one doctor.
    const perDoctor = doctors.map((d) => {
      const mine = allToday.filter((p) => p.doctorId === d.id);
      const mineAppointments = mine.filter((p) => p.type === 'appointment').length;
      const mineWalkIns = mine.filter((p) => p.type === 'walkin').length;
      return {
        doctorId: d.id,
        doctorName: d.name,
        totalAppointments: mineAppointments,
        totalWalkIns: mineWalkIns,
        // "Booked today" means everyone added today, phoned-in or
        // walk-in — totalAppointments alone undercounts it.
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

  // Only closes out TODAY's unarrived bookings; a future appointment
  // hasn't been missed yet. Also stamps last_closed_date so the End of
  // day panel can show a closed state and grey the button out instead
  // of letting it be clicked again as a no-op.
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
      .update({ last_closed_date: todayDateStr() })
      .eq('id', clinicId);
    if (clinicError) throw clinicError;
    currentClinic = null;
  }

  // Only clears the closed flag so the day can keep being worked; it
  // deliberately does not revert the no-shows closeDayNoShows() created,
  // since there's no reliable way to tell those apart from a no-show
  // marked manually earlier in the day.
  async function reopenDay() {
    const clinicId = await ensureClinicContext();
    const { error } = await sb
      .from('clinics')
      .update({ last_closed_date: null })
      .eq('id', clinicId);
    if (error) throw error;
    currentClinic = null;
  }

  // A doctor signaling "I'm done for today," separate from the
  // on_time/on_break/emergency status the "Your status"
  // panel owns. The display screen fades a doctor out 10 minutes after
  // this timestamp.
  async function closeDoctorDay(doctorId) {
    const { error } = await sb
      .from('doctors')
      .update({ day_closed_at: new Date().toISOString() })
      .eq('id', doctorId);
    if (error) throw error;
  }

  // Also resets status back to on_time with a fresh status_updated_at —
  // without this, Dashboard's "updated" time for the doctor kept showing
  // whenever their status was last touched before the day closed (hours
  // or even a day earlier), giving reception no way to tell that this
  // doctor actually just came back.
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

  // Status broadcasts made before the "Reason (optional)" field existed
  // stored an auto-generated line like "On a break for about 1 hr." in
  // this exact same status_note column (it just wasn't shown anywhere
  // yet). Those old values are still sitting on doctors who haven't
  // re-broadcast since — displaying them now as if they were a
  // genuinely-typed reason produces a redundant, garbled-looking line
  // ("On a break for 60 minutes · since 7:13 pm — On a break for about 1
  // hr."). A real typed reason essentially never matches this exact
  // machine-generated phrasing, so it's filtered out rather than shown.
  const STALE_AUTO_NOTE_RE = /^(on a break for about .+\.|running about .+ behind\.)$/i;
  function isRealStatusReason(note) {
    return !!note && !STALE_AUTO_NOTE_RE.test(note.trim());
  }

  // "Closed today" on purpose, not just "closed" — compares the LOCAL
  // calendar date of day_closed_at against today's, so a doctor who closed
  // yesterday and forgot to tap "I'm back" doesn't keep blocking bookings
  // once a new day has started. Callers never need to reset this by hand.
  function isDoctorClosedToday(doctor) {
    if (!doctor || !doctor.dayClosedAt) return false;
    const closed = new Date(doctor.dayClosedAt);
    const y = closed.getFullYear();
    const m = String(closed.getMonth() + 1).padStart(2, '0');
    const d = String(closed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}` === todayDateStr();
  }

  // ---------------- auth ----------------

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
    return data; // data.session is null if the project requires email confirmation
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

  async function requireLogin(loginPagePath) {
    if (!(await isLoggedIn())) {
      window.location.href = loginPagePath || 'login.html';
    }
  }

  async function getCurrentUserEmail() {
    const { data: { session } } = await sb.auth.getSession();
    return session ? session.user.email : null;
  }

  // Changing email triggers Supabase's own confirmation flow (checks both
  // the old and new address, per the "Secure email change" project
  // setting); the change isn't live until that's confirmed.
  async function changeEmail(newEmail) {
    const { error } = await sb.auth.updateUser({ email: newEmail });
    if (error) throw error;
  }

  // Changes the password for the CURRENTLY logged-in user.
  async function changePassword(newPassword) {
    const { error } = await sb.auth.updateUser({ password: newPassword });
    if (error) throw error;
  }

  // For the "forgot password" flow (not logged in): sends a reset link to
  // the given email; redirectTo should point at reset-password.html.
  async function requestPasswordReset(email, redirectTo) {
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw error;
  }

  // Called on reset-password.html once the user lands there from the
  // emailed link (which establishes a temporary "recovery" session) and
  // submits a new password.
  async function completePasswordReset(newPassword) {
    const { error } = await sb.auth.updateUser({ password: newPassword });
    if (error) throw error;
  }

  // ---------------- staff & roles ----------------

  function normalizeProfile(row) {
    return {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      isActive: row.is_active,
      doctorId: row.doctor_id,
      createdAt: row.created_at,
    };
  }

  // Memoized per page load: isAdmin()/canAccessBilling() (and any other
  // caller) each used to trigger their own independent auth+profile
  // round-trip. Two back-to-back fetches for the same profile on the
  // same page occasionally disagreed under a transient network hiccup —
  // one would resolve normally while the other briefly came back null —
  // which is what made the sidebar's Trends/End of day/Billing/Revenue
  // links flicker in and out depending only on which page happened to
  // hit the glitch, not on the user's actual role. Sharing one in-flight
  // promise across every caller collapses that into a single fetch, so
  // every check on a given page sees the same answer.
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

  // Billing is admin/reception only, never doctor — matches the RLS on
  // public.invoices, which has no select policy for any other role.
  async function canAccessBilling() {
    const profile = await getMyProfile();
    return !!profile && profile.isActive && (profile.role === 'admin' || profile.role === 'reception');
  }

  async function isDoctor() {
    const profile = await getMyProfile();
    return !!profile && profile.role === 'doctor' && profile.isActive;
  }

  // null for anyone but an active doctor — including a doctor whose
  // login hasn't been linked to a doctors row yet, which callers need
  // to distinguish from "not a doctor at all" to show the right
  // empty-state message.
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

  // Creates a brand-new login for a staff member. Uses a throwaway,
  // non-persisted Supabase client for the signUp call so it never touches
  // (or overwrites) the admin's own session in this browser's storage;
  // otherwise auth.signUp() would sign the admin's tab in as the new
  // staff member instead.
  async function createStaffAccount({ email, password, fullName, role, doctorId }) {
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
    });
    if (linkError) throw linkError;
  }

  async function setStaffActive(profileId, isActive) {
    const { error } = await sb.from('profiles').update({ is_active: isActive }).eq('id', profileId);
    if (error) throw error;
  }

  async function updateStaffRole(profileId, role) {
    const { error } = await sb.from('profiles').update({ role }).eq('id', profileId);
    if (error) throw error;
  }

  // A second, independently-changing control from updateStaffRole above
  // (Team's per-row "Linked doctor" select, not the role select) — kept
  // as its own function rather than folded into updateStaffRole since
  // the two fire from separate UI elements at separate times. Also the
  // backfill path for doctor-role accounts created before this existed.
  async function updateStaffDoctorLink(profileId, doctorId) {
    const { error } = await sb.from('profiles').update({ doctor_id: doctorId || null }).eq('id', profileId);
    if (error) throw error;
  }

  // ---------------- appearance (local device preference, not synced
  // across devices; this is a personal UI setting, not clinic data)
  // ----------------

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

  // ---------------- realtime ----------------

  // Fires `cb` whenever any doctor or patient row in this clinic changes;
  // reception, doctor view, and the display board all use this to stay
  // in sync across genuinely different devices, not just browser tabs.
  //
  // Debounced: every action handler already re-renders immediately after
  // its own write (for instant feedback), and this same write then echoes
  // back through realtime moments later — without debouncing, that's a
  // second full re-render stacked right on top of the first, which is
  // exactly what made buttons like "Call next patient" or "Mark arrived"
  // look like they visibly double-render/flash. A short quiet window
  // collapses a burst of events (the echo, plus any other rows the same
  // write touched) into one render instead of one per event.
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
    getDoctors,
    getDoctor,
    addDoctor,
    updateDoctor,
    setDoctorActive,

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
    isRealStatusReason,
    escapeHtml,
    confirmDialog,
    attachDatePicker,
    getQueueStatus,

    signUp,
    login,
    logout,
    isLoggedIn,
    requireLogin,
    getCurrentUserEmail,
    changeEmail,
    changePassword,
    requestPasswordReset,
    completePasswordReset,

    getMyProfile,
    isAdmin,
    canAccessBilling,
    isDoctor,
    getMyDoctorId,
    getTeam,
    createStaffAccount,
    setStaffActive,
    updateStaffRole,
    updateStaffDoctorLink,

    getTheme,
    setTheme,

    onLiveChange,
  };
})(window);
