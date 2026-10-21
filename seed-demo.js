const Database = require('better-sqlite3');
const db = new Database('assessment.db');

const count = db.prepare('SELECT COUNT(*) AS c FROM exams').get().c;
if (count === 0) {
  const exam = db.prepare('INSERT INTO exams (title, subject, duration) VALUES (?, ?, ?)').run(
    'Secure Digital Assessment Demo',
    'Full Stack Development',
    10
  );

  const examId = exam.lastInsertRowid;
  const insert = db.prepare(`
    INSERT INTO questions
    (exam_id, question, option_a, option_b, option_c, option_d, answer)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const questions = [
    ['Which technology is commonly used to create the server side of a web application?', 'HTML', 'CSS', 'Node.js', 'Photoshop', 'C'],
    ['Which SQL command is used to retrieve data?', 'SELECT', 'DELETE', 'DROP', 'ALTER', 'A'],
    ['What does API stand for?', 'Application Programming Interface', 'Applied Program Internet', 'Advanced Page Index', 'Application Process Input', 'A'],
    ['Which HTTP method is normally used to submit new data?', 'GET', 'POST', 'READ', 'FETCH', 'B'],
    ['Which language is used to style web pages?', 'HTML', 'CSS', 'SQL', 'Java', 'B'],
    ['What is authentication mainly used for?', 'Checking identity', 'Changing colors', 'Sorting arrays', 'Compressing files', 'A'],
    ['What is automated evaluation useful for in MCQ exams?', 'Faster result generation', 'Increasing exam duration', 'Removing questions', 'Disabling login', 'A'],
    ['Which feature can help detect suspicious exam behavior?', 'Proctoring', 'Dark mode', 'Font size', 'Footer', 'A']
  ];

  const tx = db.transaction(() => {
    questions.forEach((q) => insert.run(examId, ...q));
  });

  tx();
  console.log('Demo exam created successfully with ID:', examId);
} else {
  console.log('Demo exam already exists. Total exams:', count);
}

const exams = db.prepare('SELECT id, title, subject, duration FROM exams ORDER BY id DESC').all();
console.log(JSON.stringify(exams, null, 2));
