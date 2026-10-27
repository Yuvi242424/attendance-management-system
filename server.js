// =========================
// server.js – FINAL FIXED
// =========================

require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const expressLayouts = require('express-ejs-layouts');
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------ Semester window ------------------ */
const SEM_START = new Date('2025-10-01');
const SEM_END = new Date('2026-03-01');

function isDateInSemester(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return false;
  const ymd = d.toISOString().slice(0, 10);
  const ds = new Date(ymd);
  return ds >= SEM_START && ds <= SEM_END;
}

/* ------------------ Core Middleware ------------------ */
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'change-me',
    resave: false,
    saveUninitialized: false,
  })
);

app.use((req, res, next) => {
  res.locals.isAuthenticated = !!req.session.user;
  res.locals.currentUser = req.session.user || null;
  next();
});

/* ------------------ Auth Helper ------------------ */
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

/* ------------------ Auth Routes ------------------ */
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const validUser = process.env.TEACHER_USER || 'teacher';
  const validPass = process.env.TEACHER_PASS || 'secret123';

  if (username === validUser && password === validPass) {
    req.session.user = { username };
    return res.redirect('/dashboard');
  }

  res.status(401).render('login', { error: 'Invalid username or password' });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

/* ------------------ Dashboard ------------------ */
app.get('/', (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const [[studentsRow]] = await pool.query(
      'SELECT COUNT(*) AS count FROM students'
    );
    const totalStudents = studentsRow.count || 0;

    const [[attRow]] = await pool.query(`
      SELECT COUNT(*) AS total_records,
             SUM(CASE WHEN status = 'P' THEN 1 ELSE 0 END) AS total_present
      FROM attendance
    `);

    const totalRecords = attRow.total_records || 0;
    const totalPresent = attRow.total_present || 0;

    const overallPercentage = totalRecords
      ? Math.round((totalPresent / totalRecords) * 1000) / 10
      : 0;

    res.render('dashboard', {
      totalStudents,
      totalRecords,
      overallPercentage,
    });
  } catch (err) {
    console.error('Dashboard error', err);
    res.status(500).send('Error loading dashboard');
  }
});

/* ------------------ Students ------------------ */
app.get('/students', requireAuth, async (req, res) => {
  try {
    const [students] = await pool.query(
      'SELECT * FROM students ORDER BY roll_no'
    );
    res.render('students', { students });
  } catch (err) {
    console.error('Students list error', err);
    res.status(500).send('Error loading students');
  }
});

app.post('/students/add', requireAuth, async (req, res) => {
  const { roll_no, name } = req.body;
  try {
    await pool.query(
      'INSERT INTO students (roll_no, name) VALUES (?, ?)',
      [roll_no, name]
    );
  } catch (err) {
    console.error('Add student error', err);
  }
  res.redirect('/students');
});

app.post('/students/delete/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    await pool.query('DELETE FROM attendance WHERE student_id = ?', [id]);
    await pool.query('DELETE FROM subject_attendance WHERE student_id = ?', [
      id,
    ]);
    await pool.query('DELETE FROM students WHERE id = ?', [id]);
  } catch (err) {
    console.error('Delete student error', err);
  }
  res.redirect('/students');
});

/* ------------------ Subjects ------------------ */
app.get('/subjects', requireAuth, async (req, res) => {
  try {
    const [subjects] = await pool.query('SELECT * FROM subjects ORDER BY code');
    res.render('subjects', { subjects });
  } catch (err) {
    console.error('Subjects list error', err);
    res.status(500).send('Error loading subjects');
  }
});

app.post('/subjects/add', requireAuth, async (req, res) => {
  const { code, name } = req.body;
  try {
    await pool.query('INSERT INTO subjects (code, name) VALUES (?, ?)', [
      code,
      name,
    ]);
  } catch (err) {
    console.error('Add subject error', err);
  }
  res.redirect('/subjects');
});

app.post('/subjects/delete/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    await pool.query('DELETE FROM subject_attendance WHERE subject_id = ?', [
      id,
    ]);
    await pool.query('DELETE FROM subjects WHERE id = ?', [id]);
  } catch (err) {
    console.error('Delete subject error', err);
  }
  res.redirect('/subjects');
});

/* ------------------ Daily Attendance ------------------ */
app.get('/attendance', requireAuth, async (req, res) => {
  try {
    const [students] = await pool.query(
      'SELECT * FROM students ORDER BY roll_no'
    );
    const today = new Date().toISOString().slice(0, 10);
    res.render('attendance', { students, date: today });
  } catch (err) {
    console.error('Attendance page error', err);
    res.status(500).send('Error loading attendance page');
  }
});

app.post('/attendance', requireAuth, async (req, res) => {
  console.log('BODY /attendance:', req.body);

  const { date } = req.body;
  const statuses = req.body.status || {};

  if (!isDateInSemester(date)) {
    return res.status(400).send('Date is outside the semester range.');
  }

  try {
    const [students] = await pool.query(
      'SELECT id FROM students ORDER BY roll_no'
    );

    const rows = students.map((s, index) => {
      const key = String(s.id);
      let submitted;

      if (Array.isArray(statuses)) {
        // case: status is ['P','A','N'] or [ ['N','P'], ['N','A'], ... ]
        submitted = statuses[index];
      } else {
        // case: status is { '1': 'P', '2': 'A', ... }
        submitted = statuses[key];
      }

      // If we got ['N','P'], take the last value → 'P'
      if (Array.isArray(submitted)) {
        submitted = submitted[submitted.length - 1];
      }

      if (submitted != null) {
        submitted = String(submitted).toUpperCase();
      }

      const finalStatus =
        submitted === 'P' || submitted === 'A' ? submitted : 'N';

      return [s.id, date, finalStatus];
    });

    await pool.query(
      `
      INSERT INTO attendance (student_id, date, status)
      VALUES ?
      ON DUPLICATE KEY UPDATE status = VALUES(status)
      `,
      [rows]
    );

    res.redirect('/attendance/report?date=' + encodeURIComponent(date));
  } catch (err) {
    console.error('Save attendance error', err);
    res.status(500).send('Error saving attendance');
  }
});

app.get('/attendance/report', requireAuth, async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);

  try {
    const [records] = await pool.query(
      `
      SELECT s.roll_no, s.name, a.status
      FROM students s
      LEFT JOIN attendance a
        ON s.id = a.student_id
       AND a.date = ?
      ORDER BY s.roll_no
      `,
      [date]
    );

    const [summary] = await pool.query(
      `
      SELECT s.id, s.roll_no, s.name,
             COUNT(a.id) AS total_days,
             SUM(CASE WHEN a.status = 'P' THEN 1 ELSE 0 END) AS present_days,
             CASE
               WHEN COUNT(a.id) = 0 THEN 0
               ELSE ROUND(
                 SUM(CASE WHEN a.status = 'P' THEN 1 ELSE 0 END)
                 / COUNT(a.id) * 100, 1
               )
             END AS percentage
      FROM students s
      LEFT JOIN attendance a
        ON s.id = a.student_id
      GROUP BY s.id, s.roll_no, s.name
      ORDER BY s.roll_no
      `
    );

    res.render('report', { records, summary, date });
  } catch (err) {
    console.error('Report error', err);
    res.status(500).send('Error loading report');
  }
});

/* ------------------ Subject-wise Attendance ------------------ */
app.get('/attendance/subject', requireAuth, async (req, res) => {
  try {
    const [students] = await pool.query(
      'SELECT * FROM students ORDER BY roll_no'
    );
    const [subjects] = await pool.query(
      'SELECT id, code, name FROM subjects ORDER BY code'
    );
    const today = new Date().toISOString().slice(0, 10);

    res.render('subject_attendance', {
      students,
      subjects,
      date: today,
    });
  } catch (err) {
    console.error('Subject attendance page error', err);
    res.status(500).send('Error loading subject attendance page');
  }
});

app.post('/attendance/subject', requireAuth, async (req, res) => {
  console.log('BODY /attendance/subject:', req.body);

  const { date, subject_id } = req.body;
  const subjectId = parseInt(subject_id, 10);
  const statuses = req.body.status || {};

  if (!subjectId) {
    return res.status(400).send('Subject is required.');
  }
  if (!isDateInSemester(date)) {
    return res.status(400).send('Date is outside the semester range.');
  }

  try {
    const [students] = await pool.query(
      'SELECT id FROM students ORDER BY roll_no'
    );

    const rows = students.map((s, index) => {
      const key = String(s.id);
      let submitted;

      if (Array.isArray(statuses)) {
        // case: status is [ ['N','P'], ['N','A'], ['N','N'] ]
        submitted = statuses[index];
      } else {
        // case: status is { '1': 'P', '2': 'A', ... }
        submitted = statuses[key];
      }

      // If we got ['N','P'], take the last value → 'P'
      if (Array.isArray(submitted)) {
        submitted = submitted[submitted.length - 1];
      }

      if (submitted != null) {
        submitted = String(submitted).toUpperCase();
      }

      const finalStatus =
        submitted === 'P' || submitted === 'A' ? submitted : 'N';

      return [s.id, subjectId, date, finalStatus];
    });

    await pool.query(
      `
      INSERT INTO subject_attendance (student_id, subject_id, date, status)
      VALUES ?
      ON DUPLICATE KEY UPDATE status = VALUES(status)
      `,
      [rows]
    );

    res.redirect(
      `/attendance/subject/report?subject_id=${subjectId}&date=${encodeURIComponent(
        date
      )}`
    );
  } catch (err) {
    console.error('Save subject attendance error', err);
    res.status(500).send('Error saving subject attendance');
  }
});

app.get('/attendance/subject/report', requireAuth, async (req, res) => {
  const subjectId = parseInt(req.query.subject_id, 10);
  const date = req.query.date || new Date().toISOString().slice(0, 10);

  if (!subjectId) return res.status(400).send('Subject is required.');

  try {
    const [[subject]] = await pool.query(
      'SELECT id, code, name FROM subjects WHERE id = ?',
      [subjectId]
    );

    const [records] = await pool.query(
      `
      SELECT s.roll_no, s.name, sa.status
      FROM students s
      LEFT JOIN subject_attendance sa
        ON s.id = sa.student_id
       AND sa.subject_id = ?
       AND sa.date = ?
      ORDER BY s.roll_no
      `,
      [subjectId, date]
    );

    res.render('subject_report', { subject, date, records });
  } catch (err) {
    console.error('Subject report error', err);
    res.status(500).send('Error loading subject report');
  }
});

/* ------------------ Start Server ------------------ */
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
