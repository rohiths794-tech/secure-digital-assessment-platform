# Secure Digital Assessment Platform

An academic assessment platform using Node.js, Express, SQLite, and a browser-based interface.

## Features

- Teacher and student sign-in with server-side sessions and role-checked API routes.
- Password hashing with Node.js `scrypt`; existing demo credentials are upgraded to hashes when the server starts.
- Exam creation, assigned exam access, MCQ evaluation, results, and score analytics.
- Server-created exam sessions with server-authoritative duration, ownership checks, and one-time submission.
- Persisted monitoring events for browser tab visibility, window focus, fullscreen exit, clipboard actions, camera availability/disconnection, and optional screen-share interruption.
- Instructor live monitoring dashboard with actual sessions/events, severity filtering, candidate search, and review status actions.
- Explicit pre-exam monitoring notice. Camera and screen video stay in the browser; neither is uploaded or stored.
- Responsive UI and accessible keyboard focus states.

## Run locally

Install Node.js 20+ and install project dependencies:

```text
npm install
npm start
```

Open `http://localhost:3000`. Demo accounts:

- Instructor: `teacher` / `teacher123`
- Student: `student` / `student123`

Change these demo credentials before using the app with real users. There is no registration or password-reset workflow yet.

## Configuration

- `PORT` — HTTP port (defaults to `3000`).
- `ASSESSMENT_DB` — SQLite file path (defaults to `assessment.db` in the project directory).
- `NODE_ENV=production` — marks the session cookie `Secure`; production deployment must use HTTPS. Configure TLS at the hosting platform or reverse proxy.

## Vercel deployment

The repository includes a Vercel Express function entry point and `vercel.json`. Import the repository into Vercel or run the Vercel CLI after authenticating, then deploy. Vercel uses ephemeral function storage; this project's SQLite file is placed in `/tmp` there, so application data can reset on cold starts and is not shared reliably between function instances. Use a managed persistent database before relying on deployed accounts, exams, sessions, or results. Do not use the demo credentials for a public deployment.

The server creates the database tables and a sample examination on first launch. Existing table data is preserved. Existing plaintext passwords are migrated to `scrypt` hashes on startup.

## Browser monitoring and limitations

- Browser tab visibility, focus loss, fullscreen exit, clipboard events, and selected display-sharing interruption are recorded when the browser reports them.
- Camera permission/status is checked, and disconnection/denial is recorded. Webcam video is only previewed locally.
- Display sharing is optional and requires the candidate to choose a display using the browser permission prompt. Screen video is not transmitted to the server.
- No face detection, head-pose estimation, identity matching, audio analysis, or AI inference is implemented. No automated system labels a candidate as guilty; events are review signals and can be incomplete or inaccurate.
- A normal web page cannot monitor other applications, operating-system activity, or all navigation reliably. Screen sharing does not make that possible.
- This build does not provide live video to instructors, registration, password reset, user administration, configurable per-exam integrity policies, or evidence-retention automation.

## Tests

Run `npm test` to test authentication, role enforcement, event persistence, and duplicate-submission protection using a temporary database. Manual browser checks are still needed for camera/display permission prompts, camera disconnection, fullscreen transitions, and responsive behavior.
