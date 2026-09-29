'use strict';
const $ = (id) => document.getElementById(id);
function syncThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('theme-toggle').setAttribute('aria-pressed', String(dark));
  $('theme-toggle').setAttribute(
    'aria-label',
    dark ? 'Switch to light mode' : 'Switch to dark mode',
  );
  $('theme-label').textContent = dark ? 'Light mode' : 'Dark mode';
  $('theme-icon').textContent = dark ? '☀' : '☾';
}
$('theme-toggle').addEventListener('click', () => window.CookieCaseKitTheme.toggle());
document.addEventListener('cookiecasekit:theme', syncThemeButton);
syncThemeButton();
const state = { page: 1, view: 'all', me: null, ticket: null, sequence: 0 };
const labels = {
  open: 'Open',
  in_progress: 'In progress',
  pending: 'Pending',
  resolved: 'Resolved',
  closed: 'Closed',
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};
const transitions = {
  open: ['open', 'in_progress', 'pending', 'resolved'],
  in_progress: ['in_progress', 'open', 'pending', 'resolved'],
  pending: ['pending', 'open', 'in_progress', 'resolved'],
  resolved: ['resolved', 'open', 'closed'],
  closed: ['closed', 'open'],
};
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function options(node, values, empty) {
  node.replaceChildren();
  if (empty) node.add(new Option(empty, ''));
  values.forEach((v) => node.add(new Option(labels[v] || v, v)));
}
async function api(path, method = 'GET', body) {
  const response = await fetch(`./api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CookieCaseKit': '1' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
let toastTimer;
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 4000);
}
function initials(name) {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}
function date(value) {
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
async function load() {
  const sequence = ++state.sequence;
  const params = new URLSearchParams({ page: state.page, limit: 8 });
  if ($('search').value) params.set('q', $('search').value);
  if ($('status-filter').value) params.set('status', $('status-filter').value);
  if ($('priority-filter').value) params.set('priority', $('priority-filter').value);
  if (state.view === 'mine') params.set('assignee', 'me');
  try {
    const [list, stats] = await Promise.all([api(`cases?${params}`), api('stats')]);
    if (sequence !== state.sequence) return;
    ['active', 'pending', 'resolved', 'overdue'].forEach(
      (k) => ($(`stat-${k}`).textContent = stats[k]),
    );
    $('nav-count').textContent = stats.total;
    $('total').textContent = list.total;
    $('cases').replaceChildren();
    $('empty').hidden = list.total > 0;
    for (const ticket of list.items) {
      const row = el('tr');
      const subject = el('td');
      subject.append(el('span', 'case-number', ticket.number));
      const title = el('button', 'case-title', ticket.title);
      title.addEventListener('click', () => openCase(ticket.id));
      subject.append(title);
      const status = el('td');
      status.append(el('span', `badge ${ticket.status}`, `• ${labels[ticket.status]}`));
      const priority = el('td');
      priority.append(el('span', `priority ${ticket.priority}`, labels[ticket.priority]));
      const requester = el('td');
      const person = el('span', 'requester');
      person.append(
        el('span', 'tiny-avatar', initials(ticket.requesterName)),
        el('span', '', ticket.requesterName),
      );
      requester.append(person);
      row.append(
        subject,
        status,
        priority,
        requester,
        el('td', '', date(ticket.updatedAt)),
        el('td', '', '↗'),
      );
      row.addEventListener('click', (event) => {
        if (event.target !== title) openCase(ticket.id);
      });
      $('cases').append(row);
    }
    $('range').textContent = list.total
      ? `Showing ${(state.page - 1) * 8 + 1}–${Math.min(state.page * 8, list.total)} of ${list.total} cases`
      : '0 cases';
    $('page-label').textContent = `Page ${state.page}`;
    $('previous').disabled = state.page <= 1;
    $('next').disabled = state.page * 8 >= list.total;
  } catch (error) {
    toast(error.message);
    $('range').textContent = 'Unable to load cases';
  }
}
async function openCase(id) {
  try {
    const ticket = await api(`cases/${id}`);
    state.ticket = ticket;
    $('detail-number').textContent = ticket.number;
    $('detail-title').textContent = ticket.title;
    $('detail-description').textContent = ticket.description;
    $('detail-meta').replaceChildren(
      el('span', `badge ${ticket.status}`, labels[ticket.status]),
      el('span', '', `${ticket.category} · ${ticket.requesterName}`),
      el('span', '', `Target: ${new Date(ticket.dueAt).toLocaleString()}`),
      el('span', '', `Assigned: ${ticket.assigneeId || 'Unassigned'}`),
    );
    options($('detail-status'), transitions[ticket.status]);
    $('detail-status').value = ticket.status;
    options($('detail-priority'), state.me.priorities);
    $('detail-priority').value = ticket.priority;
    const staff = state.me.user.role !== 'requester';
    $('update-form').hidden = !staff;
    $('internal-label').hidden = !staff;
    $('audit').hidden = !staff;
    $('comments').replaceChildren();
    ticket.comments.forEach((comment) => {
      const item = el('div', `comment${comment.internal ? ' internal' : ''}`);
      item.append(
        el('strong', '', comment.authorName),
        el(
          'small',
          '',
          `${date(comment.createdAt)}${comment.internal ? ' · Internal note' : ''}${comment.source === 'email' ? ' · Email reply' : ''}`,
        ),
        el('p', '', comment.body),
      );
      $('comments').append(item);
    });
    if (!ticket.comments.length)
      $('comments').append(el('p', '', 'No replies yet. Start the conversation.'));
    $('events').replaceChildren(
      ...ticket.events.map((e) =>
        el('p', '', `${date(e.createdAt)} · ${e.actorName} · ${e.action}`),
      ),
    );
    $('detail-error').textContent = '';
    if (!$('detail-dialog').open) $('detail-dialog').showModal();
  } catch (error) {
    toast(error.message);
  }
}
async function busy(form, work, errorId) {
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach((b) => (b.disabled = true));
  try {
    $(errorId).textContent = '';
    await work();
  } catch (error) {
    $(errorId).textContent = error.message;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}
$('new-case').onclick = () => {
  $('create-error').textContent = '';
  $('create-dialog').showModal();
};
document
  .querySelectorAll('[data-close]')
  .forEach((button) => (button.onclick = () => $(button.dataset.close).close()));
$('create-form').onsubmit = (event) => {
  event.preventDefault();
  void busy(
    event.currentTarget,
    async () => {
      const ticket = await api('cases', 'POST', Object.fromEntries(new FormData($('create-form'))));
      $('create-dialog').close();
      $('create-form').reset();
      $('create-priority').value = 'normal';
      state.page = 1;
      await load();
      await openCase(ticket.id);
      toast('Case created. You’re in good hands.');
    },
    'create-error',
  );
};
$('update-form').onsubmit = (event) => {
  event.preventDefault();
  void busy(
    event.currentTarget,
    async () => {
      await api(`cases/${state.ticket.id}`, 'PATCH', {
        version: state.ticket.version,
        status: $('detail-status').value,
        priority: $('detail-priority').value,
      });
      await openCase(state.ticket.id);
      await load();
      toast('Case updated');
    },
    'detail-error',
  );
};
$('claim').onclick = () =>
  void busy(
    $('update-form'),
    async () => {
      await api(`cases/${state.ticket.id}`, 'PATCH', {
        version: state.ticket.version,
        assigneeId: state.me.user.id,
      });
      await openCase(state.ticket.id);
      await load();
    },
    'detail-error',
  );
$('comment-form').onsubmit = (event) => {
  event.preventDefault();
  void busy(
    event.currentTarget,
    async () => {
      await api(`cases/${state.ticket.id}/comments`, 'POST', {
        body: $('comment-body').value,
        internal: $('internal').checked && state.me.user.role !== 'requester',
      });
      $('comment-form').reset();
      await openCase(state.ticket.id);
      await load();
      toast('Reply added');
    },
    'detail-error',
  );
};
$('previous').onclick = () => {
  state.page--;
  void load();
};
$('next').onclick = () => {
  state.page++;
  void load();
};
$('refresh').onclick = () => void load();
let searchTimer;
$('search').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.page = 1;
    void load();
  }, 250);
};
['status-filter', 'priority-filter'].forEach(
  (id) =>
    ($(id).onchange = () => {
      state.page = 1;
      void load();
    }),
);
document.querySelectorAll('[data-view]').forEach(
  (button) =>
    (button.onclick = () => {
      state.view = button.dataset.view;
      state.page = 1;
      document
        .querySelectorAll('[data-view]')
        .forEach((b) => b.classList.toggle('selected', b === button));
      $('view-title').firstChild.textContent =
        `${{ all: 'All cases', mine: 'Assigned to me', pending: 'Waiting on customer', resolved: 'Resolved cases' }[state.view]} `;
      $('status-filter').value = ['pending', 'resolved'].includes(state.view) ? state.view : '';
      void load();
    }),
);
(async () => {
  try {
    state.me = await api('me');
    const { user, brand, categories, statuses, priorities } = state.me;
    $('brand').textContent = brand.name;
    document.title = `${brand.name} · Support workspace`;
    $('tenant').textContent = user.tenantId;
    $('user-name').textContent = user.name;
    $('user-role').textContent = `${user.role[0].toUpperCase()}${user.role.slice(1)}`;
    $('avatar').textContent = initials(user.name);
    options($('status-filter'), statuses, 'All statuses');
    options($('priority-filter'), priorities, 'All priorities');
    options($('create-category'), categories);
    options($('create-priority'), priorities);
    $('create-priority').value = 'normal';
    if (user.role === 'requester') document.querySelector('[data-view="mine"]').hidden = true;
    await load();
    const match = location.hash.match(/^#case-(\d+)$/);
    if (match) await openCase(match[1]);
  } catch (error) {
    $('user-name').textContent = 'Sign-in required';
    $('range').textContent = error.message;
    toast(error.message);
  }
})();
