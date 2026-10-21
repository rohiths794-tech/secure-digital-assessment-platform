let exams = [], currentExam = null, violations = 0, timerInterval = null, remaining = 0, stream = null, screenStream = null, pendingExamId = null;
let appUser = null;
let monitoringInterval = null;
let cameraGraceInterval = null;
let cameraHealthInterval = null;
let cameraGraceDeadline = 0;
let cameraRecoveryExpired = false;

const $ = (id) => document.getElementById(id);

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.style.display = "block";
  setTimeout(() => { el.style.display = "none"; }, 2500);
}

function showPage(id) {
  const allowedPages = appUser ? (appUser.role === "teacher" ? ["dashboard", "exams", "create", "take", "results", "analytics", "monitoring"] : ["exams", "take"]) : ["login"];
  const safeId = allowedPages.includes(id) ? id : (appUser ? (appUser.role === "teacher" ? "dashboard" : "exams") : "login");

  document.querySelectorAll(".page").forEach((page) => page.classList.remove("active"));
  const page = $(safeId);
  if (page) page.classList.add("active");

  document.querySelectorAll(".nav").forEach((button) => button.classList.toggle("active", button.dataset.page === safeId));
  clearInterval(monitoringInterval);

  if (appUser && safeId === "exams") loadExams();
  if (appUser && (safeId === "results" || safeId === "analytics")) loadResults();
  if (appUser && safeId === "monitoring") loadMonitoring();

  const nav = $("mainNav");
  if (!nav) return;

  if (!appUser) {
    nav.style.display = "none";
    return;
  }

  nav.style.display = "flex";
  document.querySelectorAll(".nav").forEach((button) => {
    const isTeacherSection = ["create", "results", "analytics", "monitoring"].includes(button.dataset.page);
    if (button.id === "logoutBtn") {
      button.style.display = "inline-flex";
    } else if (isTeacherSection && appUser.role !== "teacher") {
      button.style.display = "none";
    } else {
      button.style.display = "inline-flex";
    }
  });
}

function openStudentModal(id) {
  pendingExamId = id;
  $("monitoringConsent").checked = false;
  $("studentModal").classList.remove("hidden");
  $("studentModal").classList.add("visible");
  $("monitoringConsent").focus();
}

function closeStudentModal() {
  pendingExamId = null;
  $("studentModal").classList.add("hidden");
  $("studentModal").classList.remove("visible");
}

async function loginUser() {
  const username = $("loginUsername").value.trim();
  const password = $("loginPassword").value.trim();

  if (!username || !password) {
    toast("Please enter username and password.");
    return;
  }

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const data = await response.json();

    if (!response.ok) {
      toast(data.error || "Unable to log in.");
      return;
    }

    appUser = { username: data.username, role: data.role };
    $("loginUsername").value = "";
    $("loginPassword").value = "";

    const startPage = appUser.role === "teacher" ? "dashboard" : "exams";
    showPage(startPage);
    toast("Welcome, " + appUser.username + ".");

    if (appUser.role === "teacher") {
      loadExams();
      loadResults();
    } else {
      loadExams();
    }
  } catch (error) {
    toast("Login failed. Please try again.");
  }
}

async function logoutUser() {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  appUser = null;
  currentExam = null;
  violations = 0;
  clearInterval(timerInterval);

  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  clearInterval(cameraHealthInterval);
  cameraHealthInterval = null;
  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }

  showPage("login");
  toast("You have been logged out.");
}

document.querySelectorAll(".nav").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.id === "logoutBtn") {
      logoutUser();
      return;
    }

    if (appUser) {
      showPage(button.dataset.page);
    }
  });
});

$("takeExamButton").addEventListener("click", () => showPage("exams"));
$("openMonitoringButton").addEventListener("click", () => showPage("monitoring"));
$("cancelExamButton").addEventListener("click", closeStudentModal);
$("confirmExamButton").addEventListener("click", confirmStudentStart);
$("addQuestionButton").addEventListener("click", addQuestion);
$("createExamButton").addEventListener("click", createExam);
$("submitExamButton").addEventListener("click", submitExam);
$("refreshMonitoringButton").addEventListener("click", loadMonitoring);
$("retryCameraButton").addEventListener("click", startProctoring);
$("examList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-exam-id]");
  if (button) startExam(Number(button.dataset.examId));
});
$("eventRows").addEventListener("click", (event) => {
  const button = event.target.closest("[data-review-id]");
  if (button) reviewEvent(Number(button.dataset.reviewId), "reviewed");
});

$("loginBtn").addEventListener("click", loginUser);
$("loginPassword").addEventListener("keydown", (event) => {
  if (event.key === "Enter") loginUser();
});
$("candidateSearch").addEventListener("input", () => loadMonitoring());
$("eventSeverity").addEventListener("change", () => loadMonitoring());

async function loadExams() {
  if (!appUser) return;

  exams = await fetch("/api/exams").then((r) => r.json());

  $("examCount").textContent = exams.length;
  $("examList").innerHTML = exams.map((exam) => `
    <div class="exam-card">
      <span class="pill">${escapeHtml(exam.subject)}</span>
      <h3>${escapeHtml(exam.title)}</h3>
      <p>Assigned to ${escapeHtml(exam.assigned_to || "student")} • Secure online assessment.</p>
      <div class="exam-meta">
        <span>⏱ ${exam.duration} min</span>
        <span>📝 Exam</span>
        <span>🔐 Secure</span>
      </div>
      <button class="primary" type="button" data-exam-id="${exam.id}">Start Exam</button>
    </div>
  `).join("");
}

async function startExam(id) {
  openStudentModal(id);
}

async function confirmStudentStart() {
  if (!pendingExamId) return;

  if (!$("monitoringConsent").checked) {
    toast("Please acknowledge the monitoring notice to continue.");
    $("monitoringConsent").focus();
    return;
  }

  const examId = pendingExamId;
  closeStudentModal();
  beginExam(examId, appUser.username);
}

async function beginExam(id, studentName) {
  currentExam = await fetch("/api/exams/" + id).then(async (response) => {
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Unable to load exam.");
    }
    return response.json();
  }).catch((error) => {
    toast(error.message || "Unable to load exam.");
    return null;
  });

  if (!currentExam || !currentExam.id) return;

  const sessionResponse = await fetch("/api/exam-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ examId: currentExam.id })
  });
  const sessionData = await sessionResponse.json();
  if (!sessionResponse.ok) {
    currentExam = null;
    toast(sessionData.error || "Unable to start examination.");
    return;
  }
  currentExam.sessionId = sessionData.sessionId;
  currentExam.endsAt = sessionData.endsAt;
  currentExam.startedAt = sessionData.startedAt;

  currentExam.studentName = studentName;
  cameraRecoveryExpired = false;
  clearInterval(cameraGraceInterval);
  $("cameraWarning").hidden = true;
  $("examLockNotice").hidden = true;
  $("questionSet").disabled = false;
  $("submitExamButton").disabled = false;
  violations = 0;
  $("violations").textContent = "0";
  $("takeTitle").textContent = currentExam.title;
  $("takeSubject").textContent = currentExam.subject + " • " + currentExam.questions.length + " questions";
  $("questions").innerHTML = currentExam.questions.map((question, index) => `
    <div class="q">
      <h3>${index + 1}. ${escapeHtml(question.question)}</h3>
      ${["a", "b", "c", "d"].map((letter) => `
        <label class="option">
          <input type="radio" name="q${question.id}" value="${letter.toUpperCase()}">
          ${escapeHtml(question[letter])}
        </label>
      `).join("")}
    </div>
  `).join("");

  remaining = Math.max(0, Math.ceil((Date.parse(currentExam.endsAt) - Date.now()) / 1000));
  updateTimer();
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    remaining -= 1;
    updateTimer();
    if (remaining <= 0) {
      clearInterval(timerInterval);
      submitExam();
    }
  }, 1000);

  showPage("take");
  startProctoring();

  if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
}

function updateTimer() {
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  $("timer").textContent = String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
}

async function startProctoring() {
  $("proctorStatus").textContent = "Requesting camera permission...";

  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access is not supported in this browser.");
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    if (cameraRecoveryExpired) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
      $("proctorStatus").textContent = "Camera restored too late. Contact your instructor to unlock the exam.";
      return;
    }
    $("camera").srcObject = stream;
    $("proctorStatus").textContent = "Camera active • Monitoring enabled";
    clearCameraGrace();
    stream.getVideoTracks().forEach((track) => {
      track.addEventListener("ended", () => handleCameraUnavailable("Camera disconnected. Turn it back on within 20 seconds."));
      track.addEventListener("mute", () => handleCameraUnavailable("Camera is unavailable. Turn it back on within 20 seconds."));
      track.addEventListener("unmute", () => handleCameraRestored());
    });
    clearInterval(cameraHealthInterval);
    cameraHealthInterval = setInterval(() => {
      const track = stream?.getVideoTracks()[0];
      if (currentExam && (!track || track.readyState !== "live" || track.muted || !track.enabled)) {
        handleCameraUnavailable("Camera is unavailable. Turn it back on within 20 seconds.");
      } else if (currentExam && track && !track.muted && track.readyState === "live" && !cameraRecoveryExpired) {
        handleCameraRestored();
      }
    }, 1000);
  } catch (error) {
    $("proctorStatus").textContent = "Camera unavailable • Browser monitoring still active";
    if (currentExam) {
      startCameraGrace("Camera permission is off or unavailable. Enable it within 20 seconds to continue.");
      $("proctorStatus").textContent = "Camera unavailable • 20-second recovery period";
      addViolation("Camera unavailable or permission denied", 1, "camera_unavailable", "technical");
    }
  }
}

function startCameraGrace(message) {
  if (!currentExam || cameraRecoveryExpired || cameraGraceInterval) return;
  cameraGraceDeadline = Date.now() + 20000;
  $("cameraWarning").hidden = false;
  const update = () => {
    const seconds = Math.max(0, Math.ceil((cameraGraceDeadline - Date.now()) / 1000));
    const warning = `${message} Time remaining: ${seconds} seconds.`;
    $("cameraWarning").textContent = warning;
    $("proctorStatus").textContent = `Camera recovery required • ${seconds} seconds remaining`;
    if (seconds <= 0) lockExamForCamera();
  };
  update();
  cameraGraceInterval = setInterval(update, 250);
}

function clearCameraGrace() {
  clearInterval(cameraGraceInterval);
  cameraGraceInterval = null;
  cameraGraceDeadline = 0;
  $("cameraWarning").hidden = true;
}

function handleCameraUnavailable(message) {
  if (!currentExam || cameraRecoveryExpired) return;
  if (cameraGraceInterval) return;
  $("proctorStatus").textContent = "Camera unavailable • restore it to continue";
  startCameraGrace(message);
  addViolation("Camera disconnected", 1, "camera_disconnected", "technical");
}

function handleCameraRestored() {
  if (cameraRecoveryExpired) return;
  $("proctorStatus").textContent = "Camera active • Monitoring enabled";
  clearCameraGrace();
}

function lockExamForCamera() {
  if (cameraRecoveryExpired) return;
  cameraRecoveryExpired = true;
  clearInterval(cameraGraceInterval);
  cameraGraceInterval = null;
  $("cameraWarning").hidden = true;
  $("cameraWarning").textContent = "";
  $("questionSet").disabled = true;
  $("submitExamButton").disabled = true;
  $("examLockNotice").hidden = false;
  $("proctorStatus").textContent = "Exam locked • Contact your instructor";
  toast("Exam locked because camera access was not restored within 20 seconds.");
  addViolation("Camera recovery grace period expired; exam locked for instructor assistance", 1, "camera_recovery_failed", "technical");
}

async function startScreenShare() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    $("screenShareStatus").textContent = "This browser does not support display sharing.";
    return;
  }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    $("screenShareStatus").textContent = "Display sharing is active. No screen video is uploaded or stored.";
    screenStream.getVideoTracks()[0].addEventListener("ended", () => {
      screenStream = null;
      $("screenShareStatus").textContent = "Display sharing stopped. Resume it if required by your exam.";
      if (currentExam) addViolation("Display sharing stopped", 1, "screen_share_stopped", "technical");
    });
  } catch (error) {
    $("screenShareStatus").textContent = "Display sharing was not started. Browser monitoring remains limited to this exam page.";
  }
}
$("screenShareButton").addEventListener("click", startScreenShare);

async function addViolation(reason, weight = 1, eventType = "tab_hidden", severity = "low") {
  violations += weight;
  $("violations").textContent = String(violations);
  toast("Monitoring notice: " + reason + " • This event is not proof of misconduct.");
  if (currentExam?.sessionId) {
    await fetch("/api/monitoring/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: currentExam.sessionId, eventType, severity, details: reason })
    }).catch(() => {});
  }
}

document.addEventListener("visibilitychange", () => {
  if (currentExam && $("take").classList.contains("active") && document.hidden) {
    addViolation("Examination tab became hidden", 1, "tab_hidden", "medium");
  }
});

document.addEventListener("fullscreenchange", () => {
  if (currentExam && $("take").classList.contains("active") && !document.fullscreenElement) {
    addViolation("Fullscreen mode was exited", 1, "fullscreen_exit", "medium");
  }
});

window.addEventListener("blur", () => {
  if (currentExam && $("take").classList.contains("active")) {
    addViolation("Examination window lost focus", 1, "window_blur", "low");
  }
});

document.addEventListener("copy", (event) => {
  if (!currentExam) return;
  event.preventDefault();
  addViolation("Copy action blocked during examination", 1, "clipboard_attempt", "low");
});
document.addEventListener("cut", (event) => {
  if (!currentExam) return;
  event.preventDefault();
  addViolation("Cut action blocked during examination", 1, "clipboard_attempt", "low");
});
document.addEventListener("paste", (event) => {
  if (!currentExam) return;
  event.preventDefault();
  addViolation("Paste action blocked during examination", 1, "clipboard_attempt", "low");
});
document.addEventListener("keydown", (event) => {
  if (currentExam && (event.ctrlKey || event.metaKey) && ["c", "v", "x", "p"].includes(event.key.toLowerCase())) {
    event.preventDefault();
    addViolation("Prohibited keyboard shortcut blocked", 1, "clipboard_attempt", "low");
  }
});

async function submitExam() {
  if (!currentExam) return;
  if (cameraRecoveryExpired) {
    toast("The exam is locked. Please contact your instructor.");
    return;
  }

  clearInterval(timerInterval);

  const answers = {};
  currentExam.questions.forEach((question) => {
    const input = document.querySelector(`input[name="q${question.id}"]:checked`);
    if (input) answers[question.id] = input.value;
  });

  const result = await fetch("/api/attempts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: currentExam.sessionId,
      answers
    })
  }).then(async (r) => {
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Could not submit the examination.");
    return data;
  }).catch((error) => {
    toast(error.message);
    return null;
  });

  if (!result) return;

  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }
  clearInterval(cameraHealthInterval);
  cameraHealthInterval = null;
  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }

  currentExam = null;

  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }

  alert(`Exam submitted!\nScore: ${result.score}/${result.total}\nPercentage: ${(result.score / result.total * 100).toFixed(1)}%\nIntegrity alerts: ${result.violations}`);
  showPage(appUser && appUser.role === "teacher" ? "results" : "exams");
  loadResults();
  loadExams();
}

async function loadResults() {
  if (!appUser) return;

  const rows = await fetch("/api/results").then((r) => r.json());

  $("attemptCount").textContent = rows.length;
  const alerts = rows.reduce((sum, row) => sum + row.violations, 0);
  $("violationCount").textContent = alerts;

  const avg = rows.length ? rows.reduce((sum, row) => sum + (row.score / row.total * 100), 0) / rows.length : 0;
  $("avgScore").textContent = avg.toFixed(0) + "%";
  $("aAttempts").textContent = rows.length;
  $("aAverage").textContent = avg.toFixed(1) + "%";
  $("aAlerts").textContent = alerts;

  $("resultsBody").innerHTML = rows.length ? rows.map((row) => `
    <tr>
      <td><b>${escapeHtml(row.student_name)}</b></td>
      <td>${escapeHtml(row.title)}</td>
      <td>${row.score}/${row.total}</td>
      <td>${(row.score / row.total * 100).toFixed(1)}%</td>
      <td>${row.violations}</td>
      <td>${new Date(row.started_at).toLocaleString()}</td>
    </tr>
  `).join("") : `<tr><td colspan="6">No attempts yet. Take the demo exam first.</td></tr>`;

  const dist = [0, 0, 0, 0, 0];
  rows.forEach((row) => {
    const percentage = row.score / row.total * 100;
    dist[Math.min(4, Math.floor(percentage / 20))] += 1;
  });

  $("bars").innerHTML = dist.map((value, index) => `
    <div class="bar-row">
      <span class="bar-label">${index * 20}-${index === 4 ? 100 : index * 20 + 19}%</span>
      <div class="bar" style="width:${Math.max(2, value * 45)}px"></div>
      <span class="bar-value">${value} attempt(s)</span>
    </div>
  `).join("");
}

async function loadMonitoring() {
  if (!appUser || appUser.role !== "teacher") return;
  const connection = $("monitorConnection");
  try {
    const severity = $("eventSeverity").value;
    const [overviewResponse, eventResponse] = await Promise.all([
      fetch("/api/monitoring/overview"),
      fetch("/api/monitoring/events" + (severity ? "?severity=" + encodeURIComponent(severity) : ""))
    ]);
    if (!overviewResponse.ok || !eventResponse.ok) throw new Error("Could not load monitoring data.");
    const overview = await overviewResponse.json();
    const events = await eventResponse.json();
    connection.textContent = "Connected · updated " + new Date().toLocaleTimeString();
    connection.classList.add("connected");
    $("activeCandidates").textContent = overview.metrics.active;
    $("completedExams").textContent = overview.metrics.completed;
    $("attentionCandidates").textContent = overview.metrics.attention;
    $("technicalIssues").textContent = overview.metrics.technical;

    const query = $("candidateSearch").value.trim().toLowerCase();
    const candidates = overview.candidates.filter((candidate) => `${candidate.student_name} ${candidate.exam_title}`.toLowerCase().includes(query));
    $("candidateRows").innerHTML = candidates.length ? candidates.map((candidate) => {
      const seconds = Math.max(0, Math.ceil((Date.parse(candidate.ends_at) - Date.now()) / 1000));
      const time = candidate.status === "active" ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s` : "—";
      const alert = candidate.current_alert ? `<span class="severity ${escapeHtml(candidate.current_alert)}">${escapeHtml(candidate.current_alert)}</span>` : "No open alerts";
      const lastEvent = candidate.last_event ? `${escapeHtml(candidate.last_event.replaceAll("_", " "))}<small>${new Date(candidate.last_event_at.replace(" ", "T") + "Z").toLocaleString()}</small>` : "No events";
      return `<tr><td><b>${escapeHtml(candidate.student_name)}</b><small>${escapeHtml(candidate.exam_title)}</small></td><td><span class="status-tag ${escapeHtml(candidate.status)}">${escapeHtml(candidate.status)}</span></td><td>${time}</td><td>${candidate.event_count}</td><td>${alert}<small>${lastEvent}</small></td></tr>`;
    }).join("") : `<tr><td colspan="5">No matching examination sessions yet.</td></tr>`;

    $("eventRows").innerHTML = events.length ? events.map((event) => {
      const action = event.review_status === "open" ? `<button class="review-button" type="button" data-review-id="${event.id}">Mark reviewed</button>` : `<span class="review-status">${escapeHtml(event.review_status)}</span>`;
      const timestamp = new Date(event.created_at.replace(" ", "T") + "Z").toLocaleString();
      return `<tr><td>${timestamp}</td><td><b>${escapeHtml(event.student_name)}</b><small>${escapeHtml(event.exam_title)}</small></td><td>${escapeHtml(event.event_type.replaceAll("_", " "))}<small>${escapeHtml(event.details || "Browser-reported event; context may be incomplete.")}</small></td><td><span class="severity ${escapeHtml(event.severity)}">${escapeHtml(event.severity)}</span></td><td>${escapeHtml(event.review_status)}</td><td>${action}</td></tr>`;
    }).join("") : `<tr><td colspan="6">No events match this filter.</td></tr>`;
    if (!monitoringInterval) monitoringInterval = setInterval(loadMonitoring, 8000);
  } catch (error) {
    connection.textContent = "Connection unavailable · retrying";
    connection.classList.remove("connected");
  }
}

async function reviewEvent(id, status) {
  const response = await fetch(`/api/monitoring/events/${id}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status })
  });
  const data = await response.json();
  if (!response.ok) return toast(data.error || "Unable to update review status.");
  toast("Event marked reviewed. This does not establish misconduct.");
  loadMonitoring();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>\"']/g, (letter) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[letter]));
}

let qCount = 0;

function addQuestion() {
  qCount += 1;
  const div = document.createElement("div");
  div.className = "question-editor";
  div.dataset.q = String(qCount);
  div.innerHTML = `
    <b>Question ${qCount}</b>
    <textarea class="qtext" placeholder="Enter question"></textarea>
    <div class="option-grid">
      <input class="qa" placeholder="Option A">
      <input class="qb" placeholder="Option B">
      <input class="qc" placeholder="Option C">
      <input class="qd" placeholder="Option D">
    </div>
    <label>Correct Answer
      <select class="ans">
        <option value="A">A</option>
        <option value="B">B</option>
        <option value="C">C</option>
        <option value="D">D</option>
      </select>
    </label>
  `;
  $("questionBuilder").appendChild(div);
}

async function createExam() {
  const title = $("examTitle").value.trim();
  const subject = $("examSubject").value.trim();
  const duration = Number($("examDuration").value);
  const assignedTo = $("assignedTo").value.trim();
  const editors = [...document.querySelectorAll(".question-editor")];
  const questions = editors.map((editor) => ({
    question: editor.querySelector(".qtext").value.trim(),
    a: editor.querySelector(".qa").value.trim(),
    b: editor.querySelector(".qb").value.trim(),
    c: editor.querySelector(".qc").value.trim(),
    d: editor.querySelector(".qd").value.trim(),
    answer: editor.querySelector(".ans").value
  }));

  if (!title || !subject || !duration || questions.some((q) => Object.values(q).some((value) => !value))) {
    toast("Fill all exam and question fields.");
    return;
  }

  const response = await fetch("/api/exams", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, subject, duration, questions, assignedTo })
  });
  const data = await response.json();

  if (!response.ok) {
    toast(data.error || "Could not create exam");
    return;
  }

  toast("Exam created successfully and assigned to " + (assignedTo || "student") + ".");
  $("examTitle").value = "";
  $("examSubject").value = "";
  $("assignedTo").value = "student";
  $("questionBuilder").innerHTML = "";
  qCount = 0;
  addQuestion();
  showPage("exams");
  loadExams();
}

showPage("login");
addQuestion();
if ($("mainNav")) $("mainNav").style.display = "none";
if ($("studentModal")) {
  $("studentModal").classList.add("hidden");
  $("studentModal").classList.remove("visible");
}
fetch("/api/session").then(async (response) => {
  if (!response.ok) return null;
  return response.json();
}).then((session) => {
  if (!session) return;
  appUser = session;
  showPage(session.role === "teacher" ? "dashboard" : "exams");
  loadExams();
  loadResults();
}).catch(() => {});
