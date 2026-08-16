'use strict';

// --- Tab switching ---------------------------------------------------------
const tabs = document.querySelectorAll('.tab');
const views = {
  notes: document.getElementById('view-notes'),
  instagram: document.getElementById('view-instagram'),
};

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const view = tab.dataset.view;
    Object.entries(views).forEach(([name, el]) =>
      el.classList.toggle('hidden', name !== view)
    );
    if (view === 'instagram') loadBackups();
  });
});

// --- Elements --------------------------------------------------------------
const postForm = document.getElementById('post-form');
const urlInput = document.getElementById('ig-url');
const userInput = document.getElementById('ig-user');
const passInput = document.getElementById('ig-pass');
const twoFaInput = document.getElementById('ig-2fa');
const fetchBtn = document.getElementById('fetch-btn');
const fetchStatus = document.getElementById('fetch-status');
const preview = document.getElementById('preview');
const previewUser = document.getElementById('preview-user');
const previewGrid = document.getElementById('preview-grid');
const saveBtn = document.getElementById('save-btn');
const gallery = document.getElementById('gallery');
const igEmpty = document.getElementById('ig-empty');

// The post currently being previewed.
let current = null;

function setStatus(msg, kind) {
  fetchStatus.textContent = msg || '';
  fetchStatus.className = 'fetch-status' + (kind ? ' ' + kind : '');
  fetchStatus.classList.toggle('hidden', !msg);
}

// --- Fetch a post ----------------------------------------------------------
postForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  const payload = { url };
  if (userInput.value.trim() && passInput.value) {
    payload.login = {
      user: userInput.value.trim(),
      password: passInput.value,
      code: twoFaInput.value.trim(),
    };
  }

  fetchBtn.disabled = true;
  fetchBtn.textContent = 'Fetching…';
  preview.classList.add('hidden');
  setStatus('Opening the post and reading its media…', 'running');

  try {
    const res = await fetch('/api/ig/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not fetch that post.');
    passInput.value = '';
    twoFaInput.value = '';
    current = data;
    renderPreview(data);
    setStatus('', null);
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    fetchBtn.disabled = false;
    fetchBtn.textContent = 'Fetch post';
  }
});

function renderPreview(data) {
  const notes = data.notes && data.notes.length ? ` — ${data.notes.join(' · ')}` : '';
  previewUser.textContent = `@${data.username} · ${data.media.length} item(s)${notes}`;
  previewGrid.innerHTML = '';
  for (const m of data.media) {
    const cell = document.createElement('div');
    cell.className = 'gallery-cell';
    cell.innerHTML =
      m.type === 'video'
        ? `<video src="${m.url}" controls preload="metadata"></video>`
        : `<img src="${m.url}" alt="" />`;
    previewGrid.appendChild(cell);
  }
  saveBtn.disabled = false;
  saveBtn.textContent = `Save all (${data.media.length})`;
  preview.classList.remove('hidden');
}

// --- Save the previewed post ----------------------------------------------
saveBtn.addEventListener('click', async () => {
  if (!current) return;
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  try {
    const res = await fetch('/api/ig/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: current.username, media: current.media }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed.');
    const added = data.saved.filter((s) => !s.existing).length;
    setStatus(
      `Saved ${added} new file(s) to @${data.username}` +
        (data.skipped ? ` (${data.skipped} already saved)` : '') + '.',
      'done'
    );
    preview.classList.add('hidden');
    current = null;
    loadBackups();
  } catch (err) {
    setStatus(err.message, 'error');
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save all';
  }
});

// --- Gallery ---------------------------------------------------------------
async function loadBackups() {
  try {
    const res = await fetch('/api/backups');
    const backups = await res.json();
    renderGallery(backups);
  } catch (_) {
    /* ignore */
  }
}

function renderGallery(backups) {
  gallery.innerHTML = '';
  const hasAny = backups.some((b) => b.count > 0);
  igEmpty.classList.toggle('hidden', hasAny);

  for (const backup of backups) {
    if (backup.count === 0) continue;
    gallery.appendChild(buildProfileSection(backup));
  }
}

// A collapsible <details> section per profile, with per-item checkboxes and a
// bulk action toolbar (select all / download / delete).
function buildProfileSection(backup) {
  const details = document.createElement('details');
  details.className = 'gallery-profile';
  details.open = true;

  const summary = document.createElement('summary');
  summary.innerHTML = `@${escapeHtmlIg(backup.profile)} <span class="gallery-count">${backup.count} item(s)</span>`;
  details.appendChild(summary);

  const toolbar = document.createElement('div');
  toolbar.className = 'gallery-toolbar';
  toolbar.innerHTML = `
    <label class="select-all"><input type="checkbox" class="sel-all" /> Select all</label>
    <span class="sel-count"></span>
    <span class="toolbar-spacer"></span>
    <button type="button" class="btn btn-ghost btn-sm act-download" disabled>↓ Download</button>
    <button type="button" class="btn btn-ghost btn-sm act-delete" disabled>🗑 Delete</button>
  `;
  details.appendChild(toolbar);

  const grid = document.createElement('div');
  grid.className = 'gallery-grid';
  details.appendChild(grid);

  const checkboxes = [];
  for (const file of backup.files) {
    const cell = document.createElement('div');
    cell.className = 'gallery-cell';

    const media =
      file.type === 'video'
        ? `<video src="${file.url}" controls preload="metadata"></video>`
        : `<a href="${file.url}" target="_blank" rel="noopener"><img src="${file.url}" loading="lazy" alt="" /></a>`;

    cell.innerHTML = `
      <label class="cell-check"><input type="checkbox" data-name="${escapeHtmlIg(file.name)}" /></label>
      ${media}
      <a class="gallery-download" href="${file.url}" download="${escapeHtmlIg(file.name)}">↓ Save</a>
    `;
    grid.appendChild(cell);
    checkboxes.push(cell.querySelector('input[type="checkbox"]'));
  }

  // Wire up selection + bulk actions for this section.
  const selAll = toolbar.querySelector('.sel-all');
  const selCount = toolbar.querySelector('.sel-count');
  const btnDownload = toolbar.querySelector('.act-download');
  const btnDelete = toolbar.querySelector('.act-delete');

  const selectedNames = () =>
    checkboxes.filter((c) => c.checked).map((c) => c.dataset.name);

  const refresh = () => {
    const n = selectedNames().length;
    selCount.textContent = n ? `${n} selected` : '';
    btnDownload.disabled = n === 0;
    btnDelete.disabled = n === 0;
    selAll.checked = n > 0 && n === checkboxes.length;
    selAll.indeterminate = n > 0 && n < checkboxes.length;
  };

  checkboxes.forEach((c) => c.addEventListener('change', refresh));
  selAll.addEventListener('change', () => {
    checkboxes.forEach((c) => (c.checked = selAll.checked));
    refresh();
  });
  btnDownload.addEventListener('click', () =>
    downloadSelected(backup.profile, selectedNames())
  );
  btnDelete.addEventListener('click', () =>
    deleteSelected(backup.profile, selectedNames())
  );
  // Keep the summary from toggling when clicking the toolbar.
  toolbar.addEventListener('click', (e) => e.stopPropagation());

  refresh();
  return details;
}

async function downloadSelected(profile, names) {
  if (!names.length) return;
  try {
    const res = await fetch(
      `/api/backups/${encodeURIComponent(profile)}/download`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: names }),
      }
    );
    if (!res.ok) throw new Error('Download failed.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${profile}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(err.message);
  }
}

async function deleteSelected(profile, names) {
  if (!names.length) return;
  if (!confirm(`Delete ${names.length} item(s) from @${profile}?`)) return;
  try {
    const res = await fetch(
      `/api/backups/${encodeURIComponent(profile)}/delete`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: names }),
      }
    );
    if (!res.ok) throw new Error('Delete failed.');
    await loadBackups();
  } catch (err) {
    alert(err.message);
  }
}

function escapeHtmlIg(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
