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

  // ---------------- queue-ordering logic (same rule as before: your
  // position is based on whichever is LATER, your scheduled slot or when
  // you actually walked in, just expressed in real Date arithmetic now
  // instead of simulated minutes-since-midnight). ----------------
  function scheduledMoment(patient, doctor) {
    if (patient.type === 'walkin' || !patient.bookedDate || !patient.bookedTime) return null;
    const base = new Date(`${patient.bookedDate}T${patient.bookedTime}`);
    base.setMinutes(base.getMinutes() + ((doctor && doctor.delayMins) || 0));
    return base;
  }

  function effectiveMoment(patient, doctor) {
    if (patient.type === 'walkin') {
      return patient.arrivedAt ? new Date(patient.arrivedAt) : new Date();
    }
    const scheduled = scheduledMoment(patient, doctor);
    if (patient.arrivedAt) {
      const arrived = new Date(patient.arrivedAt);
      return arrived > scheduled ? arrived : scheduled;
    }
    return scheduled;
  }

  function isLikelyNoShow(patient, doctor, graceWindowMins) {
    if (patient.status !== 'booked' || !belongsToDate(patient, todayDateStr())) return false;
    const scheduled = scheduledMoment(patient, doctor);
    return Date.now() > scheduled.getTime() + graceWindowMins * 60000;
  }

  // token_date is set correctly for both walk-ins and appointments at
  // booking time (see 007_token_numbers.sql), so it's the one reliable
  // "which day does this visit belong to" field — unlike bookedDate,
  // which is always null for walk-ins.
  function belongsToDate(patient, dateStr) {
    return patient.tokenDate === dateStr;
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
      reason: row.reason,
      tokenNumber: row.token_number,
      tokenDate: row.token_date,
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

  async function deleteClinicClosure(closureId) {
    const { error } = await sb.from('clinic_closures').delete().eq('id', closureId);
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

  async function getDoctor(doctorId) {
    const doctors = await getDoctors({ includeInactive: true });
    return doctors.find((d) => d.id === doctorId) || null;
  }

  async function addDoctor({ name, specialty, feeNormal, feeEmergency }) {
    const clinicId = await ensureClinicContext();
    const { data, error } = await sb.from('doctors').insert({
      clinic_id: clinicId, name, specialty: specialty || '',
      fee_normal: feeNormal || 0, fee_emergency: feeEmergency || 0,
    }).select().single();
    if (error) throw error;
    return normalizeDoctor(data);
  }

  async function updateDoctor(doctorId, { name, specialty, feeNormal, feeEmergency }) {
    const { error } = await sb.from('doctors').update({
      name, specialty: specialty || '',
      fee_normal: feeNormal || 0, fee_emergency: feeEmergency || 0,
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
  // booked: [...with .likelyNoShow/.effectiveTime], done, noShow }.
  // Defaults to today; pass a dateStr to browse a different day.
  async function getQueueForDoctor(doctorId, dateStr) {
    const targetDate = dateStr || todayDateStr();
    const [doctor, clinic, mine] = await Promise.all([
      getDoctor(doctorId),
      getClinic(),
      fetchPatientsForDoctorAndDate(doctorId, targetDate),
    ]);

    const nowServing = mine.find((p) => p.status === 'in_consult') || null;

    const waiting = mine
      .filter((p) => p.status === 'waiting')
      .sort((a, b) => effectiveMoment(a, doctor) - effectiveMoment(b, doctor))
      .map((p, idx) => Object.assign({}, p, { position: idx + 1, effectiveTime: effectiveMoment(p, doctor) }));

    const booked = mine
      .filter((p) => p.status === 'booked')
      .sort((a, b) => scheduledMoment(a, doctor) - scheduledMoment(b, doctor))
      .map((p) => Object.assign({}, p, {
        likelyNoShow: isLikelyNoShow(p, doctor, clinic.grace_window_mins),
        effectiveTime: scheduledMoment(p, doctor),
      }));

    const done = mine.filter((p) => p.status === 'done');
    const noShow = mine.filter((p) => p.status === 'no_show');
    return { nowServing, waiting, booked, done, noShow };
  }

  async function getAllQueues(dateStr) {
    const doctors = await getDoctors();
    const queues = await Promise.all(doctors.map((d) => getQueueForDoctor(d.id, dateStr)));
    return doctors.map((d, i) => ({ doctor: d, queue: queues[i] }));
  }

  // Searches today's queue entries who haven't finished their visit yet:
  // booked (hasn't arrived — "mark arrived" applies) or waiting (already
  // checked in — here so a typo in their name/phone can still be fixed).
  // token_date (not booked_date, which is always null for walk-ins) is
  // the field that's reliably set for both booking types.
  async function searchBookedPatients(query) {
    const clinicId = await ensureClinicContext();
    const q = query.trim();
    if (!q || !clinicId) return [];
    const today = todayDateStr();
    const clinic = await getClinic();
    const doctors = await getDoctors();
    const doctorById = Object.fromEntries(doctors.map((d) => [d.id, d]));
    const { data, error } = await sb
      .from('patients')
      .select('*')
      .eq('clinic_id', clinicId)
      .in('status', ['booked', 'waiting'])
      .eq('token_date', today)
      .or(`name.ilike.%${q}%,phone.ilike.%${q}%`);
    if (error) throw error;
    return data.map(normalizePatient).map((p) => Object.assign({}, p, {
      likelyNoShow: p.status === 'booked' ? isLikelyNoShow(p, doctorById[p.doctorId], clinic.grace_window_mins) : false,
      effectiveTime: scheduledMoment(p, doctorById[p.doctorId]),
    }));
  }

  // Fixes a mistake caught after a patient was already added — used from
  // Reception's search results, not part of the normal add-patient flow.
  // doctorId can be corrected for any patient; bookedDate/bookedTime only
  // apply to appointment-type patients, and token_date is kept mirrored to
  // booked_date since that's the field every other query filters by.
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
  async function getBillingPatientLookup(phone) {
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

    if (!patient && !invoice) return null;
    return {
      name: (patient && patient.name) || (invoice && invoice.patient_name) || '',
      address: (patient && patient.address) || (invoice && invoice.patient_address) || '',
      gender: (patient && patient.gender) || (invoice && invoice.patient_gender) || '',
      age: (patient && patient.age) || (invoice && invoice.patient_age) || null,
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
    };
  }

  async function createInvoice({ doctorId, feeType, patientName, patientPhone, patientAddress, patientAge, patientGender, paymentMode, amountReceived }) {
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
  // dateStr is a plain "YYYY-MM-DD" in the clinic's local time (same
  // convention as todayDateStr()); the two Date objects below just turn
  // that into the actual local-time boundaries for the created_at range.
  async function getInvoicesForDate(dateStr) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    const [y, m, d] = dateStr.split('-').map(Number);
    const start = new Date(y, m - 1, d, 0, 0, 0, 0);
    const end = new Date(y, m - 1, d, 23, 59, 59, 999);
    const { data, error } = await sb.from('invoices').select('*')
      .eq('clinic_id', clinicId)
      .gte('created_at', start.toISOString())
      .lte('created_at', end.toISOString())
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data.map(normalizeInvoice);
  }

  async function getTodayInvoices() {
    return getInvoicesForDate(todayDateStr());
  }

  // Same local-time-boundary approach as getInvoicesForDate, just spanning
  // startDateStr through endDateStr inclusive instead of a single day.
  async function getInvoicesForDateRange(startDateStr, endDateStr) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    const [sy, sm, sd] = startDateStr.split('-').map(Number);
    const [ey, em, ed] = endDateStr.split('-').map(Number);
    const start = new Date(sy, sm - 1, sd, 0, 0, 0, 0);
    const end = new Date(ey, em - 1, ed, 23, 59, 59, 999);
    const { data, error } = await sb.from('invoices').select('*')
      .eq('clinic_id', clinicId)
      .gte('created_at', start.toISOString())
      .lte('created_at', end.toISOString())
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data.map(normalizeInvoice);
  }

  // token_date is a plain date column (not a timestamp), so a range filter
  // here doesn't need the local-time-boundary conversion getInvoicesForDate
  // needs for created_at.
  async function getPatientsInRange(startDateStr, endDateStr) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    const { data, error } = await sb.from('patients').select('*')
      .eq('clinic_id', clinicId)
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

  // Composing the message needs the clinic's name and grace window, and
  // the doctor's name; never lets a failure here block the booking
  // itself, since the SMS log is a nice-to-have, not the core action.
  async function queueBookingNotification({ patientId, phone, doctorId, kind, bookedDate, bookedTime, tokenNumber }) {
    try {
      const clinicId = await ensureClinicContext();
      const [clinic, doctor] = await Promise.all([getClinic(), getDoctor(doctorId)]);
      const tokenLine = tokenNumber ? ` Your token number is #${tokenNumber}.` : '';
      const link = tokenNumber ? queueLinkFor(patientId) : '';
      const queueLine = link ? ` See the current token being served and the next 5 in line, so you know when to leave home: ${link}` : '';
      const message = kind === 'appointment'
        ? `Hi! Your appointment with ${doctor.name} at ${clinic.name} is on ` +
          `${formatDateLabel(bookedDate)} at ${formatTime(parseTime(bookedTime))}.${tokenLine} ` +
          `Please arrive ${clinic.grace_window_mins} min early.${queueLine} – ${clinic.name}`
        : `Hi! You're in the queue for ${doctor.name} at ${clinic.name}.${tokenLine}` +
          (queueLine || ' We\'ll keep you posted on your turn.') +
          ` – ${clinic.name}`;
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
    const doctor = await getDoctor(doctorId);
    const today = todayDateStr();
    const mine = await fetchPatientsForDoctorAndDate(doctorId, today);
    const current = mine.find((p) => p.status === 'in_consult');
    if (current) {
      await sb.from('patients').update({ status: 'done' }).eq('id', current.id);
    }
    const waiting = mine.filter((p) => p.status === 'waiting').sort((a, b) => effectiveMoment(a, doctor) - effectiveMoment(b, doctor));
    if (waiting.length > 0) {
      await sb.from('patients').update({ status: 'in_consult' }).eq('id', waiting[0].id);
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

  async function countActiveAtSlot(doctorId, dateStr, timeStr, excludePatientId) {
    const clinicId = await ensureClinicContext();
    const clinic = await getClinic();
    const targetBucket = bucketStartMinutes(timeStr, clinic.slot_interval_mins);
    const { data, error } = await sb
      .from('patients')
      .select('id, booked_time')
      .eq('clinic_id', clinicId)
      .eq('doctor_id', doctorId)
      .eq('type', 'appointment')
      .eq('booked_date', dateStr)
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
    return {
      count,
      capacity: clinic.slot_capacity,
      isFull,
      suggestion: isFull ? await findNextAvailableSlot(doctorId, dateStr, timeStr) : null,
    };
  }

  // ---------------- daily summary / close day ----------------

  async function getDailySummary(dateStr) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return { totalAppointments: 0, totalWalkIns: 0, footfallSoFar: 0, noShowCount: 0, likelyNoShowCount: 0, waitingNow: 0, doneCount: 0 };
    const targetDate = dateStr || todayDateStr();
    const [clinic, doctors, { data, error }] = await Promise.all([
      getClinic(),
      getDoctors(),
      sb.from('patients').select('*').eq('clinic_id', clinicId).eq('token_date', targetDate),
    ]);
    if (error) throw error;
    const doctorById = Object.fromEntries(doctors.map((d) => [d.id, d]));
    const todays = data.map(normalizePatient);

    return {
      totalAppointments: todays.filter((p) => p.type === 'appointment').length,
      totalWalkIns: todays.filter((p) => p.type === 'walkin').length,
      footfallSoFar: todays.filter((p) => ['waiting', 'in_consult', 'done'].indexOf(p.status) !== -1).length,
      noShowCount: todays.filter((p) => p.status === 'no_show').length,
      likelyNoShowCount: todays.filter((p) => isLikelyNoShow(p, doctorById[p.doctorId], clinic.grace_window_mins)).length,
      waitingNow: todays.filter((p) => p.status === 'waiting').length,
      doneCount: todays.filter((p) => p.status === 'done').length,
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
  // on_time/running_late/on_break/emergency status the "Your status"
  // panel owns. The display screen fades a doctor out 10 minutes after
  // this timestamp.
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
      .update({ day_closed_at: null })
      .eq('id', doctorId);
    if (error) throw error;
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
    if (error) return false;
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
      createdAt: row.created_at,
    };
  }

  async function getMyProfile() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;
    const { data, error } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    if (error) throw error;
    return data ? normalizeProfile(data) : null;
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
  async function createStaffAccount({ email, password, fullName, role }) {
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
  async function onLiveChange(cb) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return;
    sb.channel('clinic-' + clinicId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'patients', filter: `clinic_id=eq.${clinicId}` }, cb)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'doctors', filter: `clinic_id=eq.${clinicId}` }, cb)
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
    deleteClinicClosure,
    getDoctors,
    getDoctor,
    addDoctor,
    updateDoctor,
    setDoctorActive,

    getQueueForDoctor,
    getAllQueues,
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
    getInvoiceById,
    updateInvoicePayment,
    markArrived,
    markNoShow,
    addWalkIn,
    addAppointment,
    callNextPatient,
    setDoctorStatus,
    getSlotAvailability,
    getDailySummary,
    closeDayNoShows,
    reopenDay,
    closeDoctorDay,
    reopenDoctorDay,
    isLikelyNoShow,
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
    getTeam,
    createStaffAccount,
    setStaffActive,
    updateStaffRole,

    getTheme,
    setTheme,

    onLiveChange,
  };
})(window);
