# Qlinic — Intelligent Clinic Flow Management (Prototype)

Qlinic is a Phase 1 prototype for a clinic queue-management product aimed at
clinics in Tier 2 & Tier 3 India. It gives patients an honest, updating
estimate of when to arrive, keeps the reception desk out of "how much
longer" conversations, and lets the doctor broadcast delays with one tap.

This is a static, front-end-only demo. There is no real backend, database,
or authentication — see [Production notes](#production-notes) below.

## Pages

| File | Purpose |
|---|---|
| `index.html` | Public marketing / landing page |
| `login.html` | Demo clinic admin login |
| `dashboard.html` | Clinic overview: stats, doctor status, end-of-day summary |
| `reception.html` | Search/check-in screen for the front desk |
| `doctor.html` | Doctor's screen for broadcasting delays and status |
| `display.html` | Waiting-room TV/monitor screen showing the live queue |
| `data.js` | Mock data & "backend" layer (see below) |
| `styles.css` | Shared styling for all pages |

## Running it locally

No build step or dependencies — it's plain HTML/CSS/JS. Serve the folder
with any static file server and open `index.html`, for example:

```bash
npx serve .
```

**Demo login:** `demo@qlinic.in` / `demo123`

## How the data layer works

`data.js` exposes a `Qlinic` global with functions like `addAppointment`,
`markArrived`, and `setDoctorStatus`. State is persisted to `localStorage`
so the demo survives page reloads. Every function is written as a
stand-in for a real API call, so each one can be swapped for a `fetch()`
without touching the HTML/UI code that calls it.

## Production notes

Since this prototype has no real backend, moving it toward production
would need at least:

- A real authentication system in place of the hardcoded demo credentials
  in `login.html` / `data.js`
- A real database in place of `localStorage`, shared across devices
  (reception desk, doctor, waiting-room display) instead of per-browser
- An SMS/WhatsApp integration to actually notify patients, in place of the
  simulated in-app state changes
- Multi-clinic and multi-doctor support beyond the single demo clinic
  seeded in `data.js`
