'use strict';

const form = document.getElementById('item-form');
const idInput = document.getElementById('item-id');
const nameInput = document.getElementById('name');
const linkInput = document.getElementById('link');
const descInput = document.getElementById('description');
const submitBtn = document.getElementById('submit-btn');
const cancelBtn = document.getElementById('cancel-btn');
const listEl = document.getElementById('items');
const emptyState = document.getElementById('empty-state');
const counter = document.getElementById('counter');
const filterBtns = document.querySelectorAll('.filter');

let items = [];
let filter = 'all';

// --- API ---------------------------------------------------------------
async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let message = 'Request failed';
    try {
      const data = await res.json();
      message = data.error || message;
    } catch (_) {}
    throw new Error(message);
  }
  return res.status === 204 ? null : res.json();
}

async function loadItems() {
  items = await api('/api/items');
  render();
}

// --- Rendering ---------------------------------------------------------
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function normalizeUrl(url) {
  if (/^https?:\/\//i.test(url)) return url;
  return 'https://' + url;
}

function visibleItems() {
  if (filter === 'active') return items.filter((i) => !i.completed);
  if (filter === 'completed') return items.filter((i) => i.completed);
  return items;
}

function render() {
  const visible = visibleItems();
  listEl.innerHTML = '';

  for (const item of visible) {
    const li = document.createElement('li');
    li.className = 'item' + (item.completed ? ' completed' : '');
    li.dataset.id = item.id;

    const linkHtml = item.link
      ? `<a class="item-link" href="${escapeHtml(
          normalizeUrl(item.link)
        )}" target="_blank" rel="noopener noreferrer">${escapeHtml(
          item.link
        )}</a>`
      : '';
    const descHtml = item.description
      ? `<div class="item-description">${escapeHtml(item.description)}</div>`
      : '';

    li.innerHTML = `
      <input type="checkbox" class="item-check" ${item.completed ? 'checked' : ''} />
      <div class="item-body">
        <div class="item-name">${escapeHtml(item.name)}</div>
        ${linkHtml}
        ${descHtml}
      </div>
      <div class="item-actions">
        <button class="icon-btn edit" title="Edit">✏️</button>
        <button class="icon-btn delete" title="Delete">🗑️</button>
      </div>
    `;

    li.querySelector('.item-check').addEventListener('change', () =>
      toggleItem(item)
    );
    li.querySelector('.edit').addEventListener('click', () => startEdit(item));
    li.querySelector('.delete').addEventListener('click', () =>
      deleteItem(item)
    );

    listEl.appendChild(li);
  }

  emptyState.classList.toggle('hidden', visible.length > 0);

  const remaining = items.filter((i) => !i.completed).length;
  counter.textContent = `${remaining} active · ${items.length} total`;
}

// --- Actions -----------------------------------------------------------
function resetForm() {
  idInput.value = '';
  form.reset();
  submitBtn.textContent = 'Add item';
  cancelBtn.classList.add('hidden');
}

function startEdit(item) {
  idInput.value = item.id;
  nameInput.value = item.name;
  linkInput.value = item.link;
  descInput.value = item.description;
  submitBtn.textContent = 'Save changes';
  cancelBtn.classList.remove('hidden');
  nameInput.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function toggleItem(item) {
  try {
    await api(`/api/items/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ completed: !item.completed }),
    });
    await loadItems();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteItem(item) {
  if (!confirm(`Delete "${item.name}"?`)) return;
  try {
    await api(`/api/items/${item.id}`, { method: 'DELETE' });
    await loadItems();
  } catch (err) {
    alert(err.message);
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    name: nameInput.value.trim(),
    link: linkInput.value.trim(),
    description: descInput.value.trim(),
  };
  if (!payload.name) return;

  const id = idInput.value;
  try {
    if (id) {
      await api(`/api/items/${id}`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    } else {
      await api('/api/items', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
    resetForm();
    await loadItems();
  } catch (err) {
    alert(err.message);
  }
});

cancelBtn.addEventListener('click', resetForm);

filterBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    filterBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    filter = btn.dataset.filter;
    render();
  });
});

loadItems().catch((err) => alert(err.message));
