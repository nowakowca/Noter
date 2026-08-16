'use strict';

// Must run before anything opens a file (e.g. the SQLite database below).
require('./drop-privileges');

const path = require('path');
const fs = require('fs');
const express = require('express');
const { writeZip } = require('./zip');
const db = require('./db');
const { mediaKey, extFor } = require('./scraper/instagram');
const { fetchPostMedia } = require('./scraper/post');

const IG_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// Downloaded media can live in a separate directory (e.g. a bind-mounted host
// path), configurable via MEDIA_DIR. Defaults to DATA_DIR/instagram.
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(DATA_DIR, 'instagram');
// Session cookies stay under DATA_DIR (app state), never inside MEDIA_DIR, so
// they are never exposed via /media.
const SESSION_DIR = path.join(DATA_DIR, 'ig-sessions');

fs.mkdirSync(MEDIA_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Serve downloaded media (dotfiles, e.g. .manifest.json, are ignored).
app.use('/media', express.static(MEDIA_DIR));

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

// --- Instagram: save a single post / reel by link --------------------------
function sanitizeUsername(name) {
  return String(name || '')
    .trim()
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9._]/g, '')
    .toLowerCase();
}

function credsFromBody(login) {
  if (login && login.user && login.password) {
    return {
      user: sanitizeUsername(login.user),
      password: String(login.password),
      code: login.code ? String(login.code).trim() : '',
    };
  }
  return null;
}

// Only download media from Instagram's CDN (guards against SSRF via the save
// endpoint). Localhost is allowed only when explicitly enabled for tests.
function isAllowedMediaUrl(u) {
  try {
    const host = new URL(u).hostname;
    if (/(^|\.)cdninstagram\.com$/i.test(host) || /(^|\.)fbcdn\.net$/i.test(host)) {
      return true;
    }
    if (process.env.ALLOW_LOCAL_MEDIA === '1' && (host === '127.0.0.1' || host === 'localhost')) {
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

// Fetch a post's media (for previewing) — does not save anything.
app.post('/api/ig/fetch', async (req, res) => {
  const creds = credsFromBody(req.body.login);
  try {
    const result = await fetchPostMedia({
      url: req.body.url,
      creds,
      sessionDir: SESSION_DIR,
      onLog: () => {},
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

// Save selected media (from a fetched post) to <MEDIA_DIR>/<username>/ .
app.post('/api/ig/save', async (req, res) => {
  const username = sanitizeUsername(req.body.username);
  if (!username) return res.status(400).json({ error: 'Missing username.' });

  const items = Array.isArray(req.body.media) ? req.body.media : [];
  const valid = items.filter(
    (m) => m && typeof m.url === 'string' && isAllowedMediaUrl(m.url)
  );
  if (!valid.length) {
    return res.status(400).json({ error: 'No downloadable media provided.' });
  }

  const dir = path.join(MEDIA_DIR, username);
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, '.manifest.json');
  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (_) {
    manifest = {};
  }
  let nextIndex = 0;
  for (const assigned of Object.values(manifest)) {
    const m = String(assigned).match(/_(\d+)\.[^.]+$/);
    if (m) nextIndex = Math.max(nextIndex, Number(m[1]));
  }

  const saved = [];
  let skipped = 0;
  for (const item of valid) {
    const key = mediaKey(item.url);
    if (manifest[key] && fs.existsSync(path.join(dir, manifest[key]))) {
      skipped++;
      saved.push({ name: manifest[key], existing: true });
      continue;
    }
    try {
      const resp = await fetch(item.url, {
        headers: { 'User-Agent': IG_UA, Referer: 'https://www.instagram.com/' },
      });
      if (!resp.ok) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      const ext = extFor(item.url, item.type);
      const name = `${username}_${nextIndex + 1}.${ext}`;
      fs.writeFileSync(path.join(dir, name), buf);
      nextIndex += 1;
      manifest[key] = name;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      saved.push({ name });
    } catch (_) {
      /* skip a file that fails to download */
    }
  }

  res.json({ username, saved, skipped });
});

// List downloaded backups and their media files.
app.get('/api/backups', (req, res) => {
  if (!fs.existsSync(MEDIA_DIR)) return res.json([]);
  const entries = fs
    .readdirSync(MEDIA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'));

  const backups = entries.map((dir) => {
    const files = listMediaFiles(dir.name).map((f) => ({
      name: f,
      url: `/media/${encodeURIComponent(dir.name)}/${encodeURIComponent(f)}`,
      type: /\.(mp4|mov|webm)$/i.test(f) ? 'video' : 'image',
    }));
    return { profile: dir.name, count: files.length, files };
  });

  backups.sort((a, b) => a.profile.localeCompare(b.profile));
  res.json(backups);
});

// --- Bulk operations on a profile's media ----------------------------------
const SAFE_FILE_RE = /^[a-zA-Z0-9._-]+$/;

function listMediaFiles(profile) {
  const dir = path.join(MEDIA_DIR, profile);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// Resolve requested filenames to real, safe files inside the profile dir.
function resolveRequestedFiles(profile, requested) {
  const dir = path.join(MEDIA_DIR, profile);
  const existing = new Set(listMediaFiles(profile));
  const names = Array.isArray(requested) ? requested : [];
  return names
    .filter((f) => typeof f === 'string' && SAFE_FILE_RE.test(f) && !f.startsWith('.'))
    .filter((f) => existing.has(f))
    .map((f) => ({ name: f, full: path.join(dir, f) }));
}

// Download selected files as a single zip.
app.post('/api/backups/:profile/download', (req, res) => {
  const profile = sanitizeProfile(req.params.profile);
  if (!isValidProfile(profile)) {
    return res.status(400).json({ error: 'Invalid profile.' });
  }
  const files = resolveRequestedFiles(profile, req.body.files);
  if (files.length === 0) {
    return res.status(400).json({ error: 'No matching files selected.' });
  }

  res.attachment(`${profile}.zip`);
  res.type('application/zip');
  try {
    writeZip(res, files);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: 'Failed to build zip.' });
    else res.end();
  }
});

// Delete selected files (and prune the manifest).
app.post('/api/backups/:profile/delete', (req, res) => {
  const profile = sanitizeProfile(req.params.profile);
  if (!isValidProfile(profile)) {
    return res.status(400).json({ error: 'Invalid profile.' });
  }
  const files = resolveRequestedFiles(profile, req.body.files);
  const dir = path.join(MEDIA_DIR, profile);

  let deleted = 0;
  const removedNames = new Set();
  for (const f of files) {
    try {
      fs.unlinkSync(f.full);
      removedNames.add(f.name);
      deleted++;
    } catch (_) {
      /* ignore */
    }
  }

  // Prune deleted entries from the manifest so re-runs don't think we have them.
  const manifestPath = path.join(dir, '.manifest.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    let changed = false;
    for (const key of Object.keys(manifest)) {
      if (removedNames.has(manifest[key])) {
        delete manifest[key];
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  } catch (_) {
    /* no manifest */
  }

  // Remove the now-empty profile directory.
  if (listMediaFiles(profile).length === 0) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }

  res.json({ deleted });
});

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Noter is running on http://localhost:${PORT}`);
});
