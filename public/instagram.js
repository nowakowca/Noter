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
const scrapeForm = document.getElementById('scrape-form');
const profileInput = document.getElementById('ig-profile');
const userInput = document.getElementById('ig-user');
const passInput = document.getElementById('ig-pass');
const twoFaInput = document.getElementById('ig-2fa');
const scrapeBtn = document.getElementById('scrape-btn');
const statusCard = document.getElementById('scrape-status');
const statusLabel = document.getElementById('status-label');
const statusCounts = document.getElementById('status-counts');
const statusLog = document.getElementById('status-log');
const gallery = document.getElementById('gallery');
const igEmpty = document.getElementById('ig-empty');

let pollTimer = null;

// --- Scrape ----------------------------------------------------------------
scrapeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const profile = profileInput.value.trim().replace(/^@/, '');
  if (!profile) return;

  const payload = { profile };
  if (userInput.value.trim() && passInput.value) {
    payload.login = {
      user: userInput.value.trim(),
      password: passInput.value,
      code: twoFaInput.value.trim(),
    };
  }

  scrapeBtn.disabled = true;
  scrapeBtn.textContent = 'Starting…';
  statusCard.classList.remove('hidden');

  try {
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start backup.');
    // Clear the password from the field once submitted.
    passInput.value = '';
    twoFaInput.value = '';
    renderStatus(data);
    startPolling();
  } catch (err) {
    statusLabel.textContent = 'Error';
    statusLabel.className = 'status-label error';
    statusLog.textContent = err.message;
    resetButton();
  }
});

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/scrape/status');
      const job = await res.json();
      if (!job) return;
      renderStatus(job);
      if (job.status === 'done' || job.status === 'error') {
        stopPolling();
        resetButton();
        loadBackups();
      }
    } catch (_) {
      /* keep polling */
    }
  }, 1500);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function resetButton() {
  scrapeBtn.disabled = false;
  scrapeBtn.textContent = 'Back up profile';
}

function renderStatus(job) {
  const labels = {
    running: 'Running…',
    done: 'Completed',
    error: 'Error',
  };
  statusLabel.textContent = `@${job.profile} — ${labels[job.status] || job.status}`;
  statusLabel.className = 'status-label ' + job.status;
  statusCounts.textContent =
    job.status === 'error'
      ? ''
      : `${job.downloaded} downloaded / ${job.found} found`;
  const lines = (job.log || []).map((l) => l.msg);
  if (job.error) lines.push(job.error);
  statusLog.textContent = lines.join('\n');
  statusLog.scrollTop = statusLog.scrollHeight;
}

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
    const section = document.createElement('div');
    section.className = 'gallery-profile';
    section.innerHTML = `<h3>@${escapeHtmlIg(backup.profile)} <span class="gallery-count">${backup.count} item(s)</span></h3>`;

    const grid = document.createElement('div');
    grid.className = 'gallery-grid';

    for (const file of backup.files) {
      const cell = document.createElement('div');
      cell.className = 'gallery-cell';
      if (file.type === 'video') {
        cell.innerHTML = `<video src="${file.url}" controls preload="metadata"></video>`;
      } else {
        cell.innerHTML = `<a href="${file.url}" target="_blank" rel="noopener"><img src="${file.url}" loading="lazy" alt="" /></a>`;
      }
      const dl = document.createElement('a');
      dl.href = file.url;
      dl.download = file.name;
      dl.className = 'gallery-download';
      dl.textContent = '↓ Save';
      cell.appendChild(dl);
      grid.appendChild(cell);
    }

    section.appendChild(grid);
    gallery.appendChild(section);
  }
}

function escapeHtmlIg(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
