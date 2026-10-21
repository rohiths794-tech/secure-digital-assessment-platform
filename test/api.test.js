const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Test server exited before becoming ready.");
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Test server did not become ready.");
}

test("authentication, role checks, monitoring persistence, and one-time submission", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "assessment-api-test-"));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), ASSESSMENT_DB: path.join(tempDir, "test.db") },
    stdio: "ignore"
  });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null) await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1500))]);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  await waitForServer(baseUrl, child);

  async function login(username, password) {
    const response = await fetch(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const cookie = response.headers.get("set-cookie")?.match(/assessment_session=([^;]+)/)?.[1];
    assert.equal(response.status, 200);
    assert.ok(cookie);
    return cookie;
  }

  const teacherCookie = await login("teacher", "teacher123");
  const studentCookie = await login("student", "student123");
  const unauthenticated = await fetch(`${baseUrl}/api/exams`);
  assert.equal(unauthenticated.status, 401);

  const forbiddenCreate = await fetch(`${baseUrl}/api/exams`, {
    method: "POST",
    headers: { Cookie: `assessment_session=${studentCookie}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "No", subject: "No", duration: 1, questions: [] })
  });
  assert.equal(forbiddenCreate.status, 403);

  const examsResponse = await fetch(`${baseUrl}/api/exams`, { headers: { Cookie: `assessment_session=${studentCookie}` } });
  const exams = await examsResponse.json();
  assert.equal(examsResponse.status, 200);
  assert.ok(exams.length > 0);
  const examId = exams[0].id;

  const startResponse = await fetch(`${baseUrl}/api/exam-sessions`, {
    method: "POST",
    headers: { Cookie: `assessment_session=${studentCookie}`, "Content-Type": "application/json" },
    body: JSON.stringify({ examId })
  });
  const examSession = await startResponse.json();
  assert.equal(startResponse.status, 201);

  const resumeResponse = await fetch(`${baseUrl}/api/exam-sessions`, {
    method: "POST",
    headers: { Cookie: `assessment_session=${studentCookie}`, "Content-Type": "application/json" },
    body: JSON.stringify({ examId })
  });
  const resumedSession = await resumeResponse.json();
  assert.equal(resumeResponse.status, 200);
  assert.equal(resumedSession.sessionId, examSession.sessionId);
  assert.equal(resumedSession.resumed, true);

  const eventResponse = await fetch(`${baseUrl}/api/monitoring/events`, {
    method: "POST",
    headers: { Cookie: `assessment_session=${studentCookie}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: examSession.sessionId, eventType: "tab_hidden", severity: "medium", details: "Test focus event" })
  });
  assert.equal(eventResponse.status, 201);

  const reviewDenied = await fetch(`${baseUrl}/api/monitoring/events/1/review`, {
    method: "POST",
    headers: { Cookie: `assessment_session=${studentCookie}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "dismissed" })
  });
  assert.equal(reviewDenied.status, 403);

  const teacherEvents = await fetch(`${baseUrl}/api/monitoring/events`, { headers: { Cookie: `assessment_session=${teacherCookie}` } });
  assert.ok((await teacherEvents.json()).some((event) => event.details === "Test focus event"));

  const attemptResponse = await fetch(`${baseUrl}/api/attempts`, {
    method: "POST",
    headers: { Cookie: `assessment_session=${studentCookie}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: examSession.sessionId, answers: {} })
  });
  const attempt = await attemptResponse.json();
  assert.equal(attemptResponse.status, 200);
  assert.equal(attempt.violations, 1);

  const duplicateSubmit = await fetch(`${baseUrl}/api/attempts`, {
    method: "POST",
    headers: { Cookie: `assessment_session=${studentCookie}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: examSession.sessionId, answers: {} })
  });
  assert.equal(duplicateSubmit.status, 409);

  const abandonedResponse = await fetch(`${baseUrl}/api/exam-sessions`, {
    method: "POST",
    headers: { Cookie: `assessment_session=${studentCookie}`, "Content-Type": "application/json" },
    body: JSON.stringify({ examId })
  });
  const abandonedSession = await abandonedResponse.json();
  const testDb = new Database(path.join(tempDir, "test.db"));
  testDb.prepare("UPDATE exam_sessions SET ends_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), abandonedSession.sessionId);
  testDb.close();

  const restartResponse = await fetch(`${baseUrl}/api/exam-sessions`, {
    method: "POST",
    headers: { Cookie: `assessment_session=${studentCookie}`, "Content-Type": "application/json" },
    body: JSON.stringify({ examId })
  });
  const restartedSession = await restartResponse.json();
  assert.equal(restartResponse.status, 201);
  assert.notEqual(restartedSession.sessionId, abandonedSession.sessionId);
});
