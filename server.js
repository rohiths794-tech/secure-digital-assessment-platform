const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { promisify } = require("util");
const Database = require("better-sqlite3");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
// Serverless filesystems are read-only except for /tmp, and Vercel instances are ephemeral.
const databasePath = process.env.ASSESSMENT_DB || (process.env.VERCEL ? "/tmp/assessment.db" : path.join(__dirname, "assessment.db"));
const db = new Database(databasePath);
const scrypt = promisify(crypto.scrypt);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const loginAttempts = new Map();
const eventRates = new Map();

// Apply safer defaults without introducing a runtime dependency.
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(self), microphone=(), display-capture=(self)",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  });
  next();
});
app.use(express.json({ limit: "128kb" }));
let initialization;
app.use((req, res, next) => (initialization || Promise.resolve()).then(() => next()).catch(next));
app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('teacher','student'))
);
CREATE TABLE IF NOT EXISTS exams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  duration INTEGER NOT NULL,
  assigned_to TEXT NOT NULL DEFAULT 'student',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL,
  question TEXT NOT NULL,
  option_a TEXT NOT NULL,
  option_b TEXT NOT NULL,
  option_c TEXT NOT NULL,
  option_d TEXT NOT NULL,
  answer TEXT NOT NULL,
  FOREIGN KEY(exam_id) REFERENCES exams(id)
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL,
  student_name TEXT NOT NULL,
  score INTEGER NOT NULL,
  total INTEGER NOT NULL,
  violations INTEGER NOT NULL DEFAULT 0,
  started_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS exam_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  student_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','submitted','expired')),
  submitted_at TEXT,
  FOREIGN KEY(exam_id) REFERENCES exams(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS monitoring_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('info','low','medium','high','technical')),
  details TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  confidence REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  review_status TEXT NOT NULL DEFAULT 'open' CHECK(review_status IN ('open','reviewed','dismissed','resolved')),
  reviewer TEXT,
  reviewed_at TEXT,
  FOREIGN KEY(session_id) REFERENCES exam_sessions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_exam_sessions_status ON exam_sessions(status, ends_at);
CREATE INDEX IF NOT EXISTS idx_monitoring_events_session ON monitoring_events(session_id, created_at DESC);
`);

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return scrypt(password, salt, 64).then((derived) => `scrypt$${salt}$${derived.toString("hex")}`);
}

async function verifyPassword(password, stored) {
  if (!stored.startsWith("scrypt$")) return password === stored ? "legacy" : false;
  const [, salt, expected] = stored.split("$");
  const actual = await scrypt(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  return expectedBuffer.length === actual.length && crypto.timingSafeEqual(expectedBuffer, actual);
}

const seed = async () => {
  const userCount = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  if (userCount === 0) {
    const insert = db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, ?)");
    for (const [username, password, role] of [["teacher", "teacher123", "teacher"], ["student", "student123", "student"], ["alice", "alice123", "student"]]) {
      insert.run(username, await hashPassword(password), role);
    }
  }
  // Upgrade existing demo plaintext credentials in place while preserving the accounts.
  const legacyUsers = db.prepare("SELECT id, password FROM users WHERE password NOT LIKE 'scrypt$%' ").all();
  const update = db.prepare("UPDATE users SET password = ? WHERE id = ?");
  for (const user of legacyUsers) update.run(await hashPassword(user.password), user.id);

  if (db.prepare("SELECT COUNT(*) AS c FROM exams").get().c === 0) {
    const exam = db.prepare("INSERT INTO exams (title, subject, duration, assigned_to) VALUES (?, ?, ?, ?)").run("Secure Digital Assessment Demo", "Full Stack Development", 10, "student");
    const insert = db.prepare("INSERT INTO questions (exam_id, question, option_a, option_b, option_c, option_d, answer) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const questions = [
      ["Which technology is commonly used to create the server side of a web application?", "HTML", "CSS", "Node.js", "Photoshop", "C"],
      ["Which SQL command is used to retrieve data?", "SELECT", "DELETE", "DROP", "ALTER", "A"],
      ["What does API stand for?", "Application Programming Interface", "Applied Program Internet", "Advanced Page Index", "Application Process Input", "A"],
      ["Which HTTP method is normally used to submit new data?", "GET", "POST", "READ", "FETCH", "B"],
      ["Which language is used to style web pages?", "HTML", "CSS", "SQL", "Java", "B"],
      ["What is authentication mainly used for?", "Checking identity", "Changing colors", "Sorting arrays", "Compressing files", "A"],
      ["What is automated evaluation useful for in MCQ exams?", "Faster result generation", "Increasing exam duration", "Removing questions", "Disabling login", "A"],
      ["Which feature can help detect suspicious exam behavior?", "Proctoring", "Dark mode", "Font size", "Footer", "A"]
    ];
    const transaction = db.transaction(() => questions.forEach((question) => insert.run(exam.lastInsertRowid, ...question)));
    transaction();
  }
};

initialization = seed();

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function getToken(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)assessment_session=([a-f0-9]{64})(?:;|$)/);
  return match ? match[1] : null;
}

function authenticate(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Please sign in to continue." });
  const session = db.prepare(`SELECT users.id, users.username, users.role FROM auth_sessions
    JOIN users ON users.id = auth_sessions.user_id WHERE token_hash = ? AND expires_at > ?`).get(hashToken(token), Date.now());
  if (!session) {
    res.setHeader("Set-Cookie", "assessment_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    return res.status(401).json({ error: "Your session has expired. Please sign in again." });
  }
  req.user = session;
  next();
}

function requireTeacher(req, res, next) {
  if (req.user.role !== "teacher") return res.status(403).json({ error: "Instructor access is required." });
  next();
}

function isAssigned(exam, user) {
  return user.role === "teacher" || exam.assigned_to === "student" || exam.assigned_to === user.username;
}

function cleanText(value, maxLength = 500) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

app.post("/api/login", async (req, res) => {
  const username = cleanText(req.body?.username, 80);
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!username || !password || password.length > 256) return res.status(400).json({ error: "Username and password are required." });

  const now = Date.now();
  const attempts = loginAttempts.get(req.ip);
  if (attempts && attempts.count >= 10 && now - attempts.startedAt < 10 * 60 * 1000) {
    return res.status(429).json({ error: "Too many sign-in attempts. Try again in a few minutes." });
  }
  const user = db.prepare("SELECT id, username, role, password FROM users WHERE username = ?").get(username);
  const verified = user ? await verifyPassword(password, user.password) : false;
  if (!user || !verified) {
    const record = attempts && now - attempts.startedAt < 10 * 60 * 1000 ? attempts : { count: 0, startedAt: now };
    record.count += 1;
    loginAttempts.set(req.ip, record);
    return res.status(401).json({ error: "Invalid username or password." });
  }
  loginAttempts.delete(req.ip);
  if (verified === "legacy") db.prepare("UPDATE users SET password = ? WHERE id = ?").run(await hashPassword(password), user.id);

  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now);
  db.prepare("INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(hashToken(token), user.id, now + SESSION_TTL_MS);
  const secureCookie = req.secure || process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `assessment_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secureCookie}`);
  res.json({ username: user.username, role: user.role });
});

app.get("/api/session", authenticate, (req, res) => res.json({ username: req.user.username, role: req.user.role }));
app.post("/api/logout", authenticate, (req, res) => {
  db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(hashToken(getToken(req)));
  res.setHeader("Set-Cookie", "assessment_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/exams", authenticate, (req, res) => {
  const rows = req.user.role === "teacher"
    ? db.prepare("SELECT id, title, subject, duration, assigned_to, created_at FROM exams ORDER BY id DESC").all()
    : db.prepare("SELECT id, title, subject, duration, assigned_to, created_at FROM exams WHERE assigned_to = ? OR assigned_to = 'student' ORDER BY id DESC").all(req.user.username);
  res.json(rows);
});

app.get("/api/exams/:id", authenticate, (req, res) => {
  const exam = db.prepare("SELECT id, title, subject, duration, assigned_to FROM exams WHERE id = ?").get(Number(req.params.id));
  if (!exam) return res.status(404).json({ error: "Exam not found." });
  if (!isAssigned(exam, req.user)) return res.status(403).json({ error: "This exam is not assigned to your account." });
  const questions = db.prepare("SELECT id, question, option_a AS a, option_b AS b, option_c AS c, option_d AS d FROM questions WHERE exam_id = ? ORDER BY id").all(exam.id);
  res.json({ ...exam, questions });
});

app.post("/api/exams", authenticate, requireTeacher, (req, res) => {
  const { title, subject, duration, questions } = req.body || {};
  const targetStudent = cleanText(req.body?.assignedTo || "student", 80) || "student";
  if (!cleanText(title, 160) || !cleanText(subject, 120) || !Number.isInteger(Number(duration)) || Number(duration) < 1 || Number(duration) > 360 || !Array.isArray(questions) || questions.length < 1 || questions.length > 100) {
    return res.status(400).json({ error: "Provide valid exam details, a duration from 1 to 360 minutes, and 1–100 questions." });
  }
  for (const question of questions) {
    if (![question.question, question.a, question.b, question.c, question.d].every((value) => cleanText(value, 1000)) || !["A", "B", "C", "D"].includes(question.answer)) {
      return res.status(400).json({ error: "Every question needs text, four options, and a valid correct answer." });
    }
  }
  const insertExam = db.prepare("INSERT INTO exams (title, subject, duration, assigned_to) VALUES (?, ?, ?, ?)");
  const insertQuestion = db.prepare("INSERT INTO questions (exam_id, question, option_a, option_b, option_c, option_d, answer) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const create = db.transaction(() => {
    const examResult = insertExam.run(cleanText(title, 160), cleanText(subject, 120), Number(duration), targetStudent);
    questions.forEach((question) => insertQuestion.run(examResult.lastInsertRowid, cleanText(question.question, 1000), cleanText(question.a, 1000), cleanText(question.b, 1000), cleanText(question.c, 1000), cleanText(question.d, 1000), question.answer));
    return examResult.lastInsertRowid;
  });
  const id = create();
  db.prepare("INSERT INTO audit_logs (user_id, action, details) VALUES (?, 'exam.created', ?)").run(req.user.id, `exam:${id}`);
  res.status(201).json({ message: "Exam created", id, assignedTo: targetStudent });
});

app.post("/api/exam-sessions", authenticate, (req, res) => {
  const exam = db.prepare("SELECT * FROM exams WHERE id = ?").get(Number(req.body?.examId));
  if (!exam) return res.status(404).json({ error: "Exam not found." });
  if (!isAssigned(exam, req.user)) return res.status(403).json({ error: "This exam is not assigned to your account." });
  const startMs = Date.now();
  const now = new Date(startMs).toISOString();
  // Expire stale sessions before applying the one-active-session rule.
  db.prepare("UPDATE exam_sessions SET status = 'expired' WHERE user_id = ? AND exam_id = ? AND status = 'active' AND ends_at <= ?").run(req.user.id, exam.id, now);
  const active = db.prepare("SELECT id, started_at, ends_at FROM exam_sessions WHERE user_id = ? AND exam_id = ? AND status = 'active'").get(req.user.id, exam.id);
  // A refresh/retry resumes the existing server-timed session instead of stranding it.
  if (active) return res.json({ sessionId: active.id, startedAt: active.started_at, endsAt: active.ends_at, resumed: true });
  const startedAt = new Date(startMs).toISOString();
  const endsAt = new Date(startMs + exam.duration * 60 * 1000).toISOString();
  const result = db.prepare("INSERT INTO exam_sessions (exam_id, user_id, student_name, started_at, ends_at) VALUES (?, ?, ?, ?, ?)").run(exam.id, req.user.id, req.user.username, startedAt, endsAt);
  res.status(201).json({ sessionId: result.lastInsertRowid, startedAt, endsAt });
});

const EVENT_TYPES = new Set(["tab_hidden", "window_blur", "fullscreen_exit", "clipboard_attempt", "camera_unavailable", "camera_disconnected", "camera_recovery_failed", "face_absent", "multiple_faces", "face_visibility", "screen_share_stopped", "network_offline", "candidate_report"]);
const SEVERITIES = new Set(["info", "low", "medium", "high", "technical"]);
app.post("/api/monitoring/events", authenticate, (req, res) => {
  const { sessionId, eventType, severity, details = "", durationMs = 0, confidence = null } = req.body || {};
  const session = db.prepare("SELECT * FROM exam_sessions WHERE id = ? AND user_id = ? AND status = 'active'").get(Number(sessionId), req.user.id);
  if (!session) return res.status(404).json({ error: "Active examination session not found." });
  if (Date.now() > Date.parse(session.ends_at)) return res.status(409).json({ error: "The examination time has expired." });
  if (!EVENT_TYPES.has(eventType) || !SEVERITIES.has(severity) || !Number.isFinite(Number(durationMs)) || Number(durationMs) < 0 || Number(durationMs) > 3600000 || (confidence !== null && (!Number.isFinite(Number(confidence)) || Number(confidence) < 0 || Number(confidence) > 1))) {
    return res.status(400).json({ error: "Invalid monitoring event." });
  }
  const rateKey = `${req.user.id}:${session.id}`;
  const now = Date.now();
  const rate = eventRates.get(rateKey) || [];
  const recent = rate.filter((time) => now - time < 60000);
  if (recent.length >= 60) return res.status(429).json({ error: "Monitoring event limit reached." });
  recent.push(now);
  eventRates.set(rateKey, recent);
  // Suppress browser event duplicates emitted by visibility and focus changes together.
  const duplicate = db.prepare("SELECT id FROM monitoring_events WHERE session_id = ? AND event_type = ? AND created_at >= datetime('now', '-5 seconds') ORDER BY id DESC LIMIT 1").get(session.id, eventType);
  if (duplicate) return res.status(200).json({ id: duplicate.id, deduplicated: true });
  const result = db.prepare("INSERT INTO monitoring_events (session_id, event_type, severity, details, duration_ms, confidence) VALUES (?, ?, ?, ?, ?, ?)").run(session.id, eventType, severity, cleanText(details, 300), Math.round(Number(durationMs)), confidence === null ? null : Number(confidence));
  res.status(201).json({ id: result.lastInsertRowid, createdAt: new Date().toISOString() });
});

app.post("/api/monitoring/events/:id/review", authenticate, requireTeacher, (req, res) => {
  const status = req.body?.status;
  if (!["reviewed", "dismissed", "resolved"].includes(status)) return res.status(400).json({ error: "Invalid review status." });
  const updated = db.prepare("UPDATE monitoring_events SET review_status = ?, reviewer = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, req.user.username, Number(req.params.id));
  if (!updated.changes) return res.status(404).json({ error: "Event not found." });
  db.prepare("INSERT INTO audit_logs (user_id, action, details) VALUES (?, 'monitoring.review', ?)").run(req.user.id, `event:${req.params.id};status:${status}`);
  res.json({ ok: true, status });
});

app.get("/api/monitoring/overview", authenticate, requireTeacher, (req, res) => {
  db.prepare("UPDATE exam_sessions SET status = 'expired' WHERE status = 'active' AND ends_at <= ?").run(new Date().toISOString());
  const candidates = db.prepare(`SELECT s.id AS session_id, s.student_name, s.started_at, s.ends_at, s.status, e.title AS exam_title,
      (SELECT COUNT(*) FROM monitoring_events ev WHERE ev.session_id = s.id) AS event_count,
      (SELECT severity FROM monitoring_events ev WHERE ev.session_id = s.id AND ev.review_status = 'open' ORDER BY CASE ev.severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'technical' THEN 3 WHEN 'low' THEN 4 ELSE 5 END, ev.id DESC LIMIT 1) AS current_alert,
      (SELECT event_type FROM monitoring_events ev WHERE ev.session_id = s.id ORDER BY ev.id DESC LIMIT 1) AS last_event,
      (SELECT created_at FROM monitoring_events ev WHERE ev.session_id = s.id ORDER BY ev.id DESC LIMIT 1) AS last_event_at
    FROM exam_sessions s JOIN exams e ON e.id = s.exam_id ORDER BY CASE s.status WHEN 'active' THEN 0 ELSE 1 END, s.id DESC LIMIT 100`).all();
  const metrics = {
    active: db.prepare("SELECT COUNT(*) AS count FROM exam_sessions WHERE status = 'active'").get().count,
    completed: db.prepare("SELECT COUNT(*) AS count FROM exam_sessions WHERE status IN ('submitted','expired')").get().count,
    attention: db.prepare("SELECT COUNT(DISTINCT s.id) AS count FROM exam_sessions s JOIN monitoring_events ev ON ev.session_id = s.id WHERE s.status = 'active' AND ev.review_status = 'open' AND ev.severity IN ('medium','high')").get().count,
    technical: db.prepare("SELECT COUNT(*) AS count FROM monitoring_events WHERE severity = 'technical' AND review_status = 'open'").get().count
  };
  res.json({ metrics, candidates });
});

app.get("/api/monitoring/events", authenticate, requireTeacher, (req, res) => {
  const severity = SEVERITIES.has(req.query.severity) ? req.query.severity : null;
  const rows = db.prepare(`SELECT ev.id, ev.session_id, ev.event_type, ev.severity, ev.details, ev.duration_ms, ev.confidence, ev.created_at, ev.review_status, ev.reviewer, s.student_name, e.title AS exam_title
    FROM monitoring_events ev JOIN exam_sessions s ON s.id = ev.session_id JOIN exams e ON e.id = s.exam_id
    WHERE (? IS NULL OR ev.severity = ?) ORDER BY ev.id DESC LIMIT 150`).all(severity, severity);
  res.json(rows);
});

app.post("/api/attempts", authenticate, (req, res) => {
  const sessionId = Number(req.body?.sessionId);
  const session = db.prepare("SELECT * FROM exam_sessions WHERE id = ? AND user_id = ? AND status = 'active'").get(sessionId, req.user.id);
  if (!session) return res.status(409).json({ error: "This exam session has already been submitted or is unavailable." });
  const expired = Date.now() >= Date.parse(session.ends_at);
  const questions = db.prepare("SELECT id, answer FROM questions WHERE exam_id = ? ORDER BY id").all(session.exam_id);
  const answers = req.body?.answers && typeof req.body.answers === "object" && !Array.isArray(req.body.answers) ? req.body.answers : {};
  if (!questions.length || Object.keys(answers).length > questions.length || Object.values(answers).some((answer) => !["A", "B", "C", "D"].includes(answer))) return res.status(400).json({ error: "Invalid examination answers." });
  let score = 0;
  questions.forEach((question) => { if (answers[question.id] === question.answer) score += 1; });
  const eventCount = db.prepare("SELECT COUNT(*) AS count FROM monitoring_events WHERE session_id = ?").get(session.id).count;
  const submit = db.transaction(() => {
    const attempt = db.prepare("INSERT INTO attempts (exam_id, student_name, score, total, violations, started_at) VALUES (?, ?, ?, ?, ?, ?)").run(session.exam_id, session.student_name, score, questions.length, eventCount, session.started_at);
    db.prepare("UPDATE exam_sessions SET status = ?, submitted_at = ? WHERE id = ? AND status = 'active'").run(expired ? "expired" : "submitted", new Date().toISOString(), session.id);
    return attempt.lastInsertRowid;
  });
  const id = submit();
  res.json({ id, score, total: questions.length, violations: eventCount, expired });
});

app.get("/api/results", authenticate, (req, res) => {
  const rows = db.prepare(`SELECT attempts.id, attempts.student_name, attempts.score, attempts.total, attempts.violations, attempts.started_at, exams.title, exams.subject
    FROM attempts JOIN exams ON attempts.exam_id = exams.id ${req.user.role === "student" ? "WHERE attempts.student_name = ?" : ""} ORDER BY attempts.id DESC`)
    .all(...(req.user.role === "student" ? [req.user.username] : []));
  res.json(rows);
});

app.use("/api", (req, res) => res.status(404).json({ error: "API endpoint not found." }));
app.use((error, req, res, next) => {
  console.error("Request failed:", error.message);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "An unexpected server error occurred." });
});

if (require.main === module) {
  initialization.then(() => {
    app.listen(PORT, () => console.log(`Secure Digital Assessment Platform running at http://localhost:${PORT}`));
  }).catch((error) => {
    console.error("Unable to initialize database:", error);
    process.exitCode = 1;
  });
} else {
  module.exports = app;
}
