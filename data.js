/**
 * Qlinic — mock data & "backend" layer for the Phase 1 prototype.
 *
 * Everything in this file is a stand-in for a real backend. It is deliberately
 * written as a set of functions (addAppointment, markArrived, setDoctorStatus, ...)
 * so that when a real API exists, each function body can be swapped for a
 * fetch() call without touching any of the HTML/UI code that calls them.
 *
 * State is persisted to localStorage so the demo survives page navigation
 * and refresh. This is NOT real auth or a real database — see login.html
 * and the note in README.md for what a production version needs instead.
 */
(function (global) {
  const STORAGE_KEY = 'qlinic_demo_state_v1';
  const GRACE_WINDOW_MINS = 25;

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

  function seedState() {
    return {
      clinic: {
        name: 'Qlinic Demo Clinic',
        adminEmail: 'demo@qlinic.in',
        adminPassword: 'demo123',
      },
      currentTime: '10:05',
      graceWindowMins: GRACE_WINDOW_MINS,
      doctors: [
        {
          id: 'd1',
          name: 'Dr. Anjali Rao',
          specialty: 'General Physician',
          status: 'running_late',
          delayMins: 15,
          statusNote: 'Running about 15 min behind this morning.',
          statusUpdatedAt: '09:55',
        },
        {
          id: 'd2',
          name: 'Dr. Vikram Shah',
          specialty: 'Pediatrician',
          status: 'on_time',
          delayMins: 0,
          statusNote: '',
          statusUpdatedAt: '09:00',
        },
      ],
      patients: [
        { id: 'p1', name: 'Ramesh Kumar', phone: '9876500001', doctorId: 'd1', type: 'appointment', bookedTime: '09:00', status: 'done', arrivedAt: '08:55' },
        { id: 'p2', name: 'Suman Devi', phone: '9876500002', doctorId: 'd1', type: 'appointment', bookedTime: '09:15', status: 'done', arrivedAt: '09:10' },
        { id: 'p3', name: 'Anil Verma', phone: '9876500003', doctorId: 'd1', type: 'appointment', bookedTime: '09:30', status: 'in_consult', arrivedAt: '09:28' },
        { id: 'p4', name: 'Pooja Singh', phone: '9876500004', doctorId: 'd1', type: 'walkin', bookedTime: null, status: 'waiting', arrivedAt: '09:40' },
        { id: 'p5', name: 'Rahul Kumar Verma', phone: '9876500005', doctorId: 'd1', type: 'appointment', bookedTime: '09:45', status: 'waiting', arrivedAt: '09:50' },
        { id: 'p6', name: 'Meena Kumari', phone: '9876500006', doctorId: 'd1', type: 'appointment', bookedTime: '10:00', status: 'booked', arrivedAt: null },
        { id: 'p7', name: 'Sanjay Gupta', phone: '9876500007', doctorId: 'd1', type: 'appointment', bookedTime: '09:20', status: 'booked', arrivedAt: null },
        { id: 'p8', name: 'Fatima Sheikh (for Ayaan)', phone: '9876500008', doctorId: 'd2', type: 'appointment', bookedTime: '09:30', status: 'in_consult', arrivedAt: '09:25' },
        { id: 'p9', name: 'Kavya Reddy', phone: '9876500009', doctorId: 'd2', type: 'appointment', bookedTime: '09:45', status: 'waiting', arrivedAt: '09:44' },
        { id: 'p10', name: 'Arjun Nair', phone: '9876500010', doctorId: 'd2', type: 'appointment', bookedTime: '10:15', status: 'booked', arrivedAt: null },
      ],
      nextPatientNum: 11,
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      /* fall through to reseed */
    }
    const fresh = seedState();
    save(fresh);
    return fresh;
  }

  function save(s) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  }

  let state = load();

  function persist() {
    save(state);
  }

  function getDoctor(doctorId) {
    return state.doctors.find((d) => d.id === doctorId);
  }

  function effectiveMinutes(patient) {
    const doc = getDoctor(patient.doctorId);
    if (patient.type === 'walkin') {
      return patient.arrivedAt ? parseTime(patient.arrivedAt) : parseTime(state.currentTime);
    }
    return parseTime(patient.bookedTime) + ((doc && doc.delayMins) || 0);
  }

  function isLikelyNoShow(patient) {
    if (patient.status !== 'booked') return false;
    const nowMins = parseTime(state.currentTime);
    return nowMins > effectiveMinutes(patient) + state.graceWindowMins;
  }

  const Qlinic = {
    GRACE_WINDOW_MINS,
    parseTime,
    formatTime,

    getState() {
      return state;
    },

    getClinic() {
      return state.clinic;
    },

    getCurrentTime() {
      return state.currentTime;
    },
    getCurrentTimeLabel() {
      return formatTime(parseTime(state.currentTime));
    },

    getDoctors() {
      return state.doctors;
    },
    getDoctor,

    // Returns { nowServing, waiting: [...sorted with .position], booked: [...], done: [...], noShow: [...] }
    getQueueForDoctor(doctorId) {
      const mine = state.patients.filter((p) => p.doctorId === doctorId);
      const nowServing = mine.find((p) => p.status === 'in_consult') || null;
      const waiting = mine
        .filter((p) => p.status === 'waiting')
        .sort((a, b) => effectiveMinutes(a) - effectiveMinutes(b))
        .map((p, idx) => Object.assign({}, p, { position: idx + 1, effectiveMinutes: effectiveMinutes(p) }));
      const booked = mine
        .filter((p) => p.status === 'booked')
        .sort((a, b) => effectiveMinutes(a) - effectiveMinutes(b))
        .map((p) => Object.assign({}, p, { likelyNoShow: isLikelyNoShow(p), effectiveMinutes: effectiveMinutes(p) }));
      const done = mine.filter((p) => p.status === 'done');
      const noShow = mine.filter((p) => p.status === 'no_show');
      return { nowServing, waiting, booked, done, noShow };
    },

    getAllQueues() {
      return state.doctors.map((d) => ({ doctor: d, queue: Qlinic.getQueueForDoctor(d.id) }));
    },

    searchBookedPatients(query) {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      return state.patients
        .filter((p) => p.status === 'booked')
        .filter((p) => p.name.toLowerCase().includes(q) || p.phone.includes(q))
        .map((p) => Object.assign({}, p, { likelyNoShow: isLikelyNoShow(p), effectiveMinutes: effectiveMinutes(p) }));
    },

    markArrived(patientId) {
      const p = state.patients.find((x) => x.id === patientId);
      if (!p) return;
      p.status = 'waiting';
      p.arrivedAt = state.currentTime;
      persist();
    },

    markNoShow(patientId) {
      const p = state.patients.find((x) => x.id === patientId);
      if (!p) return;
      p.status = 'no_show';
      persist();
    },

    addWalkIn(info) {
      const id = 'p' + state.nextPatientNum++;
      state.patients.push({
        id,
        name: info.name,
        phone: info.phone,
        doctorId: info.doctorId,
        type: 'walkin',
        bookedTime: null,
        status: 'waiting',
        arrivedAt: state.currentTime,
        reason: info.reason || '',
      });
      persist();
      return id;
    },

    addAppointment(info) {
      const id = 'p' + state.nextPatientNum++;
      state.patients.push({
        id,
        name: info.name,
        phone: info.phone,
        doctorId: info.doctorId,
        type: 'appointment',
        bookedTime: info.bookedTime,
        status: 'booked',
        arrivedAt: null,
      });
      persist();
      return id;
    },

    callNextPatient(doctorId) {
      const mine = state.patients.filter((p) => p.doctorId === doctorId);
      const current = mine.find((p) => p.status === 'in_consult');
      if (current) current.status = 'done';
      const waiting = mine
        .filter((p) => p.status === 'waiting')
        .sort((a, b) => effectiveMinutes(a) - effectiveMinutes(b));
      if (waiting.length > 0) {
        waiting[0].status = 'in_consult';
      }
      persist();
    },

    setDoctorStatus(doctorId, status, delayMins, note) {
      const d = getDoctor(doctorId);
      if (!d) return;
      d.status = status;
      d.delayMins = Number(delayMins) || 0;
      d.statusNote = note || '';
      d.statusUpdatedAt = state.currentTime;
      persist();
    },

    getDailySummary() {
      const totalAppointments = state.patients.filter((p) => p.type === 'appointment').length;
      const totalWalkIns = state.patients.filter((p) => p.type === 'walkin').length;
      const arrivedOrDone = state.patients.filter((p) => ['waiting', 'in_consult', 'done'].indexOf(p.status) !== -1).length;
      const noShowCount = state.patients.filter((p) => p.status === 'no_show').length;
      const likelyNoShowCount = state.patients.filter((p) => isLikelyNoShow(p)).length;
      const waitingNow = state.patients.filter((p) => p.status === 'waiting').length;
      const doneCount = state.patients.filter((p) => p.status === 'done').length;
      return {
        totalAppointments,
        totalWalkIns,
        footfallSoFar: arrivedOrDone,
        noShowCount,
        likelyNoShowCount,
        waitingNow,
        doneCount,
      };
    },

    closeDayNoShows() {
      state.patients.forEach((p) => {
        if (p.status === 'booked') p.status = 'no_show';
      });
      persist();
    },

    isLikelyNoShow,
    effectiveMinutes,

    login(email, password) {
      const ok = email.trim().toLowerCase() === state.clinic.adminEmail && password === state.clinic.adminPassword;
      if (ok) sessionStorage.setItem('qlinic_logged_in', '1');
      return ok;
    },
    isLoggedIn() {
      return sessionStorage.getItem('qlinic_logged_in') === '1';
    },
    logout() {
      sessionStorage.removeItem('qlinic_logged_in');
    },
    requireLogin(loginPagePath) {
      if (!Qlinic.isLoggedIn()) {
        window.location.href = loginPagePath || 'login.html';
      }
    },

    resetDemo() {
      localStorage.removeItem(STORAGE_KEY);
      state = load();
    },

    advanceTime(mins) {
      const total = parseTime(state.currentTime) + mins;
      const wrapped = ((total % 1440) + 1440) % 1440;
      const h = String(Math.floor(wrapped / 60)).padStart(2, '0');
      const m = String(wrapped % 60).padStart(2, '0');
      state.currentTime = `${h}:${m}`;
      persist();
    },
  };

  global.Qlinic = Qlinic;
})(window);
