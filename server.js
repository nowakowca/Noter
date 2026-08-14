'use strict';

const path = require('path');
const express = require('express');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Noter is running on http://localhost:${PORT}`);
});
