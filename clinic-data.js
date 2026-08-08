/**
 * Qlinic — real backend client, backed by Supabase (Postgres + Auth +
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

  // ---------------- time-of-day helpers (unchanged from the old data.js —
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

  // ---------------- real-timestamp helpers (new — this is what replaces
  // the simulated clinic clock) ----------------
  function formatTimestamp(value) {
    if (!value) return '—';
    const date = value instanceof Date ? value : new Date(value);
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
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
  // you actually walked in — just expressed in real Date arithmetic now
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

  function belongsToDate(patient, dateStr) {
    return patient.type === 'walkin' ? dateStr === todayDateStr() : patient.bookedDate === dateStr;
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
    };
  }

  function normalizePatient(row) {
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      address: row.address,
      gender: row.gender,
      type: row.type,
      doctorId: row.doctor_id,
      bookedDate: row.booked_date,
      bookedTime: row.booked_time ? row.booked_time.slice(0, 5) : null,
      status: row.status,
      arrivedAt: row.arrived_at,
      reason: row.reason,
      tokenNumber: row.token_number,
    };
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
  // they typed at signup time is sitting in their auth user_metadata —
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

  // fields: { name, graceWindowMins, slotIntervalMins, slotCapacity } — any
  // subset. Used by the Settings page for clinic profile + queue rules.
  async function updateClinic(fields) {
    const clinicId = await ensureClinicContext();
    const payload = {};
    if (fields.name !== undefined) payload.name = fields.name;
    if (fields.graceWindowMins !== undefined) payload.grace_window_mins = Number(fields.graceWindowMins);
    if (fields.slotIntervalMins !== undefined) payload.slot_interval_mins = Number(fields.slotIntervalMins);
    if (fields.slotCapacity !== undefined) payload.slot_capacity = Number(fields.slotCapacity);
    if (fields.displayLanguage !== undefined) payload.display_language = fields.displayLanguage;
    const { error } = await sb.from('clinics').update(payload).eq('id', clinicId);
    if (error) throw error;
    currentClinic = null; // force a fresh read next time
  }

  // Defaults to active doctors only — that's what every operational screen
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

  async function addDoctor({ name, specialty }) {
    const clinicId = await ensureClinicContext();
    const { data, error } = await sb.from('doctors').insert({ clinic_id: clinicId, name, specialty: specialty || '' }).select().single();
    if (error) throw error;
    return normalizeDoctor(data);
  }

  async function updateDoctor(doctorId, { name, specialty }) {
    const { error } = await sb.from('doctors').update({ name, specialty: specialty || '' }).eq('id', doctorId);
    if (error) throw error;
  }

  // Deactivating (not deleting) a doctor — see supabase/002_doctor_active_flag.sql
  // for why: patients.doctor_id cascades on delete, so a hard delete would
  // wipe that doctor's entire patient history.
  async function setDoctorActive(doctorId, isActive) {
    const { error } = await sb.from('doctors').update({ is_active: isActive }).eq('id', doctorId);
    if (error) throw error;
  }

  // ---------------- patient queries ----------------

  async function fetchPatientsForDoctorAndDate(doctorId, dateStr) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    let query = sb.from('patients').select('*').eq('clinic_id', clinicId).eq('doctor_id', doctorId);
    if (dateStr === todayDateStr()) {
      query = query.or(`type.eq.walkin,booked_date.eq.${dateStr}`);
    } else {
      query = query.eq('type', 'appointment').eq('booked_date', dateStr);
    }
    const { data, error } = await query;
    if (error) throw error;
    return data.map(normalizePatient);
  }

  // Returns { nowServing, waiting: [...with .position/.effectiveTime],
  // booked: [...with .likelyNoShow/.effectiveTime], done, noShow }.
  // Defaults to today; pass a dateStr to browse a different day.
  async function getQueueForDoctor(doctorId, dateStr) {
    const targetDate = dateStr || todayDateStr();
    const [doctor, clinic, rows] = await Promise.all([
      getDoctor(doctorId),
      getClinic(),
      fetchPatientsForDoctorAndDate(doctorId, targetDate),
    ]);
    const mine = rows.filter((p) => belongsToDate(p, targetDate));

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

  // Searches only today's bookings — "mark arrived" only makes sense for
  // someone who could plausibly be standing at the desk right now.
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
      .eq('status', 'booked')
      .eq('booked_date', today)
      .or(`name.ilike.%${q}%,phone.ilike.%${q}%`);
    if (error) throw error;
    return data.map(normalizePatient).map((p) => Object.assign({}, p, {
      likelyNoShow: isLikelyNoShow(p, doctorById[p.doctorId], clinic.grace_window_mins),
      effectiveTime: scheduledMoment(p, doctorById[p.doctorId]),
    }));
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
      gender: info.gender || 'other',
      type: 'appointment',
      booked_date: info.bookedDate,
      booked_time: info.bookedTime,
      status: 'booked',
      token_date: info.bookedDate,
    }).select().single();
    if (error) throw error;
    const message = await queueBookingNotification({
      patientId: data.id, phone: info.phone, doctorId: info.doctorId, kind: 'appointment',
      bookedDate: info.bookedDate, bookedTime: info.bookedTime, tokenNumber: data.token_number,
    });
    return { id: data.id, message, tokenNumber: data.token_number };
  }

  // ---------------- patient notifications ----------------
  // The tech for "text the patient their appointment time," built without
  // a live SMS provider connected. Every booking composes a message and
  // logs it as 'pending' in the notifications table — nothing is actually
  // delivered yet. Wiring up a real provider later means adding a
  // Supabase Edge Function that processes pending rows and flips them to
  // sent/failed; the booking flow itself won't need to change.

  function normalizeNotification(row) {
    return {
      id: row.id,
      patientId: row.patient_id,
      phone: row.phone,
      message: row.message,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  // The queue-status page lives next to whatever page is doing the
  // booking (reception.html today), so building the link off the
  // current page's own URL means this works on localhost, a staging
  // copy, or the real GitHub Pages site without any hardcoded domain.
  function queueLinkFor(patientId) {
    const dir = window.location.href.replace(/[^/]*$/, '');
    return `${dir}queue.html?id=${patientId}`;
  }

  // Composing the message needs the clinic's name and grace window, and
  // the doctor's name — never lets a failure here block the booking
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

  async function getNotifications(limit) {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    const { data, error } = await sb
      .from('notifications')
      .select('*')
      .eq('clinic_id', clinicId)
      .order('created_at', { ascending: false })
      .limit(limit || 20);
    if (error) throw error;
    return data.map(normalizeNotification);
  }

  // ---------------- public queue lookup (Phase 1 of the live-queue
  // feature — no page reads this yet) ----------------
  // Anonymous, no login required — this is the client-side counterpart
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
    const rows = await fetchPatientsForDoctorAndDate(doctorId, today);
    const mine = rows.filter((p) => belongsToDate(p, today));
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
      sb.from('patients').select('*').eq('clinic_id', clinicId),
    ]);
    if (error) throw error;
    const doctorById = Object.fromEntries(doctors.map((d) => [d.id, d]));
    const todays = data.map(normalizePatient).filter((p) => belongsToDate(p, targetDate));

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

  // Only closes out TODAY's unarrived bookings — a future appointment
  // hasn't been missed yet.
  async function closeDayNoShows() {
    const clinicId = await ensureClinicContext();
    const { error } = await sb
      .from('patients')
      .update({ status: 'no_show' })
      .eq('clinic_id', clinicId)
      .eq('status', 'booked')
      .eq('booked_date', todayDateStr());
    if (error) throw error;
  }

  // ---------------- auth ----------------

  async function signUp(email, password, clinicName) {
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { data: { pending_clinic_name: clinicName } },
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
  // setting) — the change isn't live until that's confirmed.
  async function changeEmail(newEmail) {
    const { error } = await sb.auth.updateUser({ email: newEmail });
    if (error) throw error;
  }

  // Changes the password for the CURRENTLY logged-in user.
  async function changePassword(newPassword) {
    const { error } = await sb.auth.updateUser({ password: newPassword });
    if (error) throw error;
  }

  // For the "forgot password" flow (not logged in) — sends a reset link to
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

  async function getTeam() {
    const clinicId = await ensureClinicContext();
    if (!clinicId) return [];
    const { data, error } = await sb.from('profiles').select('*').eq('clinic_id', clinicId).order('created_at');
    if (error) throw error;
    return data.map(normalizeProfile);
  }

  // Creates a brand-new login for a staff member. Uses a throwaway,
  // non-persisted Supabase client for the signUp call so it never touches
  // (or overwrites) the admin's own session in this browser's storage —
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
  // across devices — this is a personal UI setting, not clinic data)
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

  // Fires `cb` whenever any doctor or patient row in this clinic changes —
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
    getTodayDate: todayDateStr,
    formatDateLabel,
    isPastRealDateTime,

    getClinic,
    updateClinic,
    getDoctors,
    getDoctor,
    addDoctor,
    updateDoctor,
    setDoctorActive,

    getQueueForDoctor,
    getAllQueues,
    searchBookedPatients,
    markArrived,
    markNoShow,
    addWalkIn,
    addAppointment,
    callNextPatient,
    setDoctorStatus,
    getSlotAvailability,
    getDailySummary,
    closeDayNoShows,
    isLikelyNoShow,
    getNotifications,
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
    getTeam,
    createStaffAccount,
    setStaffActive,
    updateStaffRole,

    getTheme,
    setTheme,

    onLiveChange,
  };
})(window);
