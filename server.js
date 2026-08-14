'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const db = require('./db');
const { backupProfile } = require('./scraper/instagram');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const INSTAGRAM_DIR = path.join(DATA_DIR, 'instagram');
// Session cookies live in a dotfile dir so express.static (dotfiles: 'ignore')
// never serves them over /media.
const SESSION_DIR = path.join(INSTAGRAM_DIR, '.sessions');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Serve downloaded media (dotfiles, incl. .sessions, are ignored by default).
app.use('/media', express.static(INSTAGRAM_DIR));

// --- Prepared statements ---------------------------------------------------
const stmts = {
  all: db.prepare('SELECT * FROM items ORDER BY completed ASC, created_at DESC'),
  get: db.prepare('SELECT * FROM items WHERE id = ?'),
  insert: db.prepare(
    'INSERT INTO items (name, link, description, completed) VALUES (@name, @link, @description, @completed)'
  ),
  update: db.prepare(
    `UPDATE items
        SET name = @name,
            link = @link,
            description = @description,
            completed = @completed,
            updated_at = datetime('now')
      WHERE id = @id`
  ),
  setCompleted: db.prepare(
    `UPDATE items SET completed = @completed, updated_at = datetime('now') WHERE id = @id`
  ),
  remove: db.prepare('DELETE FROM items WHERE id = ?'),
};

// --- Helpers ---------------------------------------------------------------
function serialize(row) {
  return { ...row, completed: Boolean(row.completed) };
}

function normalizeBody(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const link = typeof body.link === 'string' ? body.link.trim() : '';
  const description =
    typeof body.description === 'string' ? body.description.trim() : '';
  const completed = body.completed ? 1 : 0;
  return { name, link, description, completed };
}

// --- Routes ----------------------------------------------------------------
app.get('/api/items', (req, res) => {
  const items = stmts.all.all().map(serialize);
  res.json(items);
});

app.post('/api/items', (req, res) => {
  const data = normalizeBody(req.body || {});
  if (!data.name) {
    return res.status(400).json({ error: 'A name is required.' });
  }
  const info = stmts.insert.run(data);
  res.status(201).json(serialize(stmts.get.get(info.lastInsertRowid)));
});

app.put('/api/items/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = stmts.get.get(id);
  if (!existing) return res.status(404).json({ error: 'Item not found.' });

  const data = normalizeBody(req.body || {});
  if (!data.name) {
    return res.status(400).json({ error: 'A name is required.' });
  }
  // Preserve the existing completed flag unless the caller explicitly sends one,
  // so editing an item's details doesn't silently un-complete it.
  const completed =
    typeof req.body.completed === 'boolean'
      ? Number(req.body.completed)
      : existing.completed;
  stmts.update.run({ id, ...data, completed });
  res.json(serialize(stmts.get.get(id)));
});

// Toggle (or set) just the completed flag.
app.patch('/api/items/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = stmts.get.get(id);
  if (!existing) return res.status(404).json({ error: 'Item not found.' });

  const completed =
    typeof req.body.completed === 'boolean'
      ? Number(req.body.completed)
      : existing.completed
      ? 0
      : 1;
  stmts.setCompleted.run({ id, completed });
  res.json(serialize(stmts.get.get(id)));
});

app.delete('/api/items/:id', (req, res) => {
  const id = Number(req.params.id);
  const info = stmts.remove.run(id);
  if (info.changes === 0) {
    return res.status(404).json({ error: 'Item not found.' });
  }
  res.status(204).end();
});

// --- Instagram backup ------------------------------------------------------
// One job at a time. Credentials are held only for the running job and never
// persisted or logged.
let currentJob = null;

function sanitizeProfile(name) {
  return String(name || '')
    .trim()
    .replace(/^@/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function isValidProfile(name) {
  return /^[a-zA-Z0-9._]{1,40}$/.test(name);
}

function publicJob(job) {
  if (!job) return null;
  return {
    profile: job.profile,
    status: job.status,
    found: job.found,
    downloaded: job.downloaded,
    log: job.log,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

app.post('/api/scrape', (req, res) => {
  if (currentJob && currentJob.status === 'running') {
    return res
      .status(409)
      .json({ error: 'A backup is already running. Only one runs at a time.' });
  }

  const profile = sanitizeProfile(req.body.profile);
  if (!isValidProfile(profile)) {
    return res.status(400).json({ error: 'Enter a valid Instagram username.' });
  }

  // Optional login. Credentials stay in this closure only.
  let creds = null;
  const login = req.body.login;
  if (login && login.user && login.password) {
    creds = {
      user: sanitizeProfile(login.user),
      password: String(login.password),
      code: login.code ? String(login.code).trim() : '',
    };
  }

  const job = {
    profile,
    status: 'running',
    found: 0,
    downloaded: 0,
    log: [],
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  currentJob = job;

  const log = (msg) => {
    job.log.push({ t: new Date().toISOString(), msg });
    if (job.log.length > 200) job.log.shift();
  };

  const outputDir = path.join(INSTAGRAM_DIR, profile);

  backupProfile({
    profile,
    creds,
    outputDir,
    sessionDir: SESSION_DIR,
    onLog: log,
    onProgress: ({ found, downloaded }) => {
      if (typeof found === 'number') job.found = found;
      if (typeof downloaded === 'number') job.downloaded = downloaded;
    },
  })
    .then((result) => {
      job.found = result.found;
      job.downloaded = result.downloaded;
      job.status = 'done';
      job.finishedAt = new Date().toISOString();
    })
    .catch((err) => {
      job.status = 'error';
      job.error = err.message || String(err);
      job.finishedAt = new Date().toISOString();
      log(`Error: ${job.error}`);
    });

  // Respond immediately; the client polls /api/scrape/status.
  res.status(202).json(publicJob(job));
});

app.get('/api/scrape/status', (req, res) => {
  res.json(publicJob(currentJob));
});

// List downloaded backups and their media files.
app.get('/api/backups', (req, res) => {
  if (!fs.existsSync(INSTAGRAM_DIR)) return res.json([]);
  const entries = fs
    .readdirSync(INSTAGRAM_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'));

  const backups = entries.map((dir) => {
    const files = fs
      .readdirSync(path.join(INSTAGRAM_DIR, dir.name))
      .filter((f) => !f.startsWith('.'))
      .map((f) => ({
        name: f,
        url: `/media/${encodeURIComponent(dir.name)}/${encodeURIComponent(f)}`,
        type: /\.(mp4|mov|webm)$/i.test(f) ? 'video' : 'image',
      }));
    return { profile: dir.name, count: files.length, files };
  });

  backups.sort((a, b) => a.profile.localeCompare(b.profile));
  res.json(backups);
});

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Noter is running on http://localhost:${PORT}`);
});
