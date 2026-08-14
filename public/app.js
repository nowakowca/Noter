'use strict';

const form = document.getElementById('item-form');
const idInput = document.getElementById('item-id');
const nameInput = document.getElementById('name');
const linkInput = document.getElementById('link');
const descInput = document.getElementById('description');
const submitBtn = document.getElementById('submit-btn');
const cancelBtn = document.getElementById('cancel-btn');
const addBtn = document.getElementById('add-btn');
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

    // The name is the hyperlink when a link is present; otherwise plain text.
    const nameHtml = item.link
      ? `<a class="item-name" href="${escapeHtml(
          normalizeUrl(item.link)
        )}" target="_blank" rel="noopener noreferrer">${escapeHtml(
          item.name
        )}</a>`
      : `<span class="item-name">${escapeHtml(item.name)}</span>`;
    const descHtml = item.description
      ? `<span class="item-description">${escapeHtml(item.description)}</span>`
      : '';

    li.innerHTML = `
      <input type="checkbox" class="item-check" ${item.completed ? 'checked' : ''} />
      <div class="item-content">
        ${nameHtml}
        ${descHtml}
      </div>
      <div class="item-actions">
        <button class="icon-btn edit" title="Edit" aria-label="Edit">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
        <button class="icon-btn delete" title="Delete" aria-label="Delete">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
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

// --- Form open / close --------------------------------------------------
function openForm() {
  form.classList.remove('hidden');
  addBtn.setAttribute('aria-expanded', 'true');
}

function closeForm() {
  idInput.value = '';
  form.reset();
  submitBtn.textContent = 'Add item';
  form.classList.add('hidden');
  addBtn.setAttribute('aria-expanded', 'false');
}

// --- Actions -----------------------------------------------------------
function startEdit(item) {
  idInput.value = item.id;
  nameInput.value = item.name;
  linkInput.value = item.link;
  descInput.value = item.description;
  submitBtn.textContent = 'Save changes';
  openForm();
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
    closeForm();
    await loadItems();
  } catch (err) {
    alert(err.message);
  }
});

cancelBtn.addEventListener('click', closeForm);

addBtn.addEventListener('click', () => {
  const isOpen = addBtn.getAttribute('aria-expanded') === 'true';
  const editing = Boolean(idInput.value);
  // Toggle closed only when it's already open as a fresh "add" form.
  if (isOpen && !editing) {
    closeForm();
  } else {
    closeForm(); // clear any in-progress edit state first
    openForm();
    nameInput.focus();
  }
});

filterBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    filterBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    filter = btn.dataset.filter;
    render();
  });
});

loadItems().catch((err) => alert(err.message));
