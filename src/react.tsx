'use client';

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { Case, Comment, Event, Priority, Status, User } from './types.js';

export interface CaseKitProps {
  /** Where your Node app mounts caseKit.router. Same-origin paths only. */
  basePath?: string;
  className?: string;
  /** Resolve a fresh host-verified bearer token for each request (Firebase, Cognito, Entra). */
  getToken?: () => string | null | Promise<string | null>;
  /** Called when the package backend returns 401. Your app owns login/navigation. */
  onUnauthorized?: () => void;
}
interface Bootstrap {
  attachments?: { maxBytes: number };
  user: User;
  brand: { name: string; accent: string };
  categories: string[];
  statuses: Status[];
  priorities: Priority[];
}
interface Detail extends Case {
  comments: Comment[];
  events: Event[];
}
interface List {
  items: Case[];
  total: number;
  page: number;
  limit: number;
}
interface Stats {
  active: number;
  pending: number;
  resolved: number;
  overdue: number;
  total: number;
}
const labels: Record<string, string> = {
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
const transitions: Record<Status, Status[]> = {
  open: ['open', 'in_progress', 'pending', 'resolved'],
  in_progress: ['in_progress', 'open', 'pending', 'resolved'],
  pending: ['pending', 'open', 'in_progress', 'resolved'],
  resolved: ['resolved', 'open', 'closed'],
  closed: ['closed', 'open'],
};
const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
const date = (value: string) =>
  new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Request failed';

function Logo({ small = false }: { small?: boolean }) {
  return (
    <svg
      className={small ? 'mini-mark' : 'brand-mark'}
      width={small ? 18 : 36}
      height={small ? 18 : 36}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
    >
      <rect width="48" height="48" rx="13" fill="#315D48" />
      <path
        d="M14 12h14l7 7v17H14a3 3 0 0 1-3-3V15a3 3 0 0 1 3-3Z"
        stroke="#F2F5E9"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M27 12v8h8M17 22h7M17 27h6" stroke="#F2F5E9" strokeWidth="2" strokeLinecap="round" />
      <circle cx="32" cy="33" r="9" fill="#D4DFB1" stroke="#315D48" strokeWidth="2" />
      <path
        d="m28.5 33 2.4 2.4 4.7-5"
        stroke="#315D48"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function Dialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="detail-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" onClick={close} aria-label="Close">
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}

interface Attachment {
  id: string;
  name: string;
  size: number;
  status: string;
  internal: boolean;
}
function AttachmentPanel({
  basePath,
  caseId,
  maxBytes,
  staff,
  getToken,
}: {
  basePath: string;
  caseId: number;
  maxBytes: number;
  staff: boolean;
  getToken?: CaseKitProps['getToken'];
}) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const tokenRef = useRef(getToken);
  tokenRef.current = getToken;
  const call = useCallback(
    async (suffix: string, init: RequestInit = {}) => {
      const token = await tokenRef.current?.();
      if (tokenRef.current && !token) throw new Error('Sign in to access attachments.');
      const res = await fetch(`${basePath}/api/cases/${caseId}/attachments${suffix}`, {
        ...init,
        credentials: 'same-origin',
        headers: {
          'X-CookieCaseKit': '1',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...init.headers,
        },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Attachment request failed');
      }
      return res;
    },
    [basePath, caseId],
  );
  const refresh = useCallback(async () => {
    const res = await call('');
    setItems((await res.json()).items);
  }, [call]);
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [refresh]);
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get('file') as File;
    if (!file?.size || file.size > maxBytes) {
      setError(`Choose a file up to ${Math.floor(maxBytes / 1024)} KB.`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await call('', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': encodeURIComponent(file.name),
          'X-Internal': String(data.get('internal') === 'on'),
        },
        body: file,
      });
      form.reset();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function download(item: Attachment) {
    setError('');
    try {
      const res = await call('/' + item.id);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = item.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section aria-label="Case attachments">
      <h3>Attachments</h3>
      <p className="hint">Files become available after a security scan.</p>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            {item.name} · {item.status}
            {item.internal ? ' · Internal' : ''}{' '}
            {item.status === 'clean' && (
              <button type="button" className="button subtle" onClick={() => void download(item)}>
                Download {item.name}
              </button>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={upload}>
        <label>
          File
          <input name="file" type="file" required />
        </label>
        {staff && (
          <label>
            <input name="internal" type="checkbox" />
            Internal attachment
          </label>
        )}
        <button className="button" disabled={busy}>
          {busy ? 'Uploading…' : 'Upload attachment'}
        </button>
        <button
          className="button subtle"
          type="button"
          onClick={() => void refresh().catch((e) => setError(e.message))}
        >
          Refresh attachments
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

/** Native React support console. Import 'cookiecasekit/react.css' once in your app. */
export function CaseKit({
  basePath = '/_casekit',
  className = '',
  onUnauthorized,
  getToken,
}: CaseKitProps) {
  const normalized = basePath.replace(/\/+$/, '');
  const validPath =
    (normalized === '' || /^\/(?!\/)/.test(normalized)) && !/[?#\\]/.test(normalized);
  const [me, setMe] = useState<Bootstrap | null>(null);
  const [list, setList] = useState<List>({ items: [], total: 0, page: 1, limit: 8 });
  const [stats, setStats] = useState<Stats>({
    active: 0,
    pending: 0,
    resolved: 0,
    overdue: 0,
    total: 0,
  });
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [view, setView] = useState('all');
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [creating, setCreating] = useState(false);
  const [ticket, setTicket] = useState<Detail | null>(null);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const detailSequence = useRef(0);
  const api = useCallback(
    async <T,>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> => {
      if (!validPath)
        throw new Error('CaseKit basePath must be a same-origin path without query or hash.');
      const token = await getTokenRef.current?.();
      if (getTokenRef.current && !token) {
        onUnauthorizedRef.current?.();
        throw new Error('Sign in with an account that has support access.');
      }
      const response = await fetch(`${normalized}/api/${path}`, {
        method,
        credentials: 'same-origin',
        signal,
        headers: {
          'Content-Type': 'application/json',
          'X-CookieCaseKit': '1',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 401) {
        setMe(null);
        setTicket(null);
        setCreating(false);
        setList({ items: [], total: 0, page: 1, limit: 8 });
        onUnauthorizedRef.current?.();
        throw new Error('Sign in with an account that has support access.');
      }
      if (!response.headers.get('content-type')?.includes('application/json'))
        throw new Error(
          'The CaseKit backend did not return JSON. Check basePath and the middleware mount.',
        );
      const result = await response.json().catch(() => ({
        error: 'The CaseKit backend did not return JSON. Check basePath and the middleware mount.',
      }));
      if (!response.ok) throw new Error(result.error || 'Request failed');
      return result as T;
    },
    [normalized, validPath],
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem('cookiecasekit-theme');
      } catch {
        /* Storage may be disabled. */
      }
      setTheme(saved === 'dark' || saved === 'light' ? saved : media.matches ? 'dark' : 'light');
    };
    sync();
    media.addEventListener('change', sync);
    window.addEventListener('storage', sync);
    return () => {
      media.removeEventListener('change', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    setMe(null);
    setTicket(null);
    setError('');
    setLoading(true);
    api<Bootstrap>('me', 'GET', undefined, controller.signal)
      .then(setMe)
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(errorMessage(e));
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
      detailSequence.current++;
    };
  }, [api]);
  useEffect(() => {
    if (!me) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ page: String(page), limit: '8' });
    if (query) params.set('q', query);
    if (status) params.set('status', status);
    if (priority) params.set('priority', priority);
    if (view === 'mine') params.set('assignee', 'me');
    Promise.all([
      api<List>(`cases?${params}`, 'GET', undefined, controller.signal),
      api<Stats>('stats', 'GET', undefined, controller.signal),
    ])
      .then(([nextList, nextStats]) => {
        if (!controller.signal.aborted) {
          setList(nextList);
          setStats(nextStats);
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, me, page, query, status, priority, view, refresh]);
  const openCase = async (id: number) => {
    const sequence = ++detailSequence.current;
    setFormError('');
    try {
      const next = await api<Detail>(`cases/${id}`);
      if (sequence === detailSequence.current) setTicket(next);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const closeDialog = () => {
    if (busy) return;
    detailSequence.current++;
    setCreating(false);
    setTicket(null);
    setFormError('');
  };
  const mutate = async (work: () => Promise<void>) => {
    setBusy(true);
    setFormError('');
    try {
      await work();
      setRefresh((n) => n + 1);
    } catch (e) {
      setFormError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  function toggleTheme() {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    try {
      localStorage.setItem('cookiecasekit-theme', next);
    } catch {
      /* Still works in memory. */
    }
  }
  function selectView(next: string) {
    setView(next);
    setStatus(['pending', 'resolved'].includes(next) ? next : '');
    setPage(1);
  }
  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void mutate(async () => {
      const created = await api<Case>('cases', 'POST', Object.fromEntries(data));
      setCreating(false);
      setPage(1);
      await openCase(created.id);
    });
  }
  function update(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ticket) return;
    const data = new FormData(event.currentTarget);
    void mutate(async () => {
      await api(`cases/${ticket.id}`, 'PATCH', {
        version: ticket.version,
        status: data.get('status'),
        priority: data.get('priority'),
      });
      await openCase(ticket.id);
    });
  }
  function reply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ticket) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    void mutate(async () => {
      await api(`cases/${ticket.id}/comments`, 'POST', {
        body: data.get('body'),
        internal: me?.user.role !== 'requester' && data.get('internal') === 'on',
      });
      form.reset();
      await openCase(ticket.id);
    });
  }
  const staff = me?.user.role !== 'requester';
  const views = [
    ['all', '▦', 'All cases'],
    ...(staff ? [['mine', '◉', 'Assigned to me']] : []),
    ['pending', '◷', 'Waiting on customer'],
    ['resolved', '✓', 'Resolved'],
  ];
  return (
    <section
      className={`cck ${className}`}
      data-theme={theme}
      style={me ? ({ '--accent': me.brand.accent } as CSSProperties) : undefined}
      aria-label="CookieCaseKit support console"
    >
      {!me ? (
        <div className="cck-notice" role={error ? 'alert' : 'status'}>
          {error || 'Loading support workspace…'}
        </div>
      ) : (
        <>
          <aside className="sidebar">
            <div className="brand">
              <Logo />
              <span>{me.brand.name}</span>
            </div>
            <div className="workspace">
              <span className="workspace-icon">S</span>
              <div>
                Support workspace<small>{me.user.tenantId}</small>
              </div>
            </div>
            <div className="nav-label">WORKSPACE</div>
            <nav aria-label="Case views">
              {views.map(([key, icon, label]) => (
                <button
                  type="button"
                  key={key}
                  className={`nav-item ${view === key ? 'selected' : ''}`}
                  onClick={() => selectView(key)}
                >
                  <span aria-hidden="true">{icon}</span>
                  {label}
                  {key === 'all' && <b>{stats.total}</b>}
                </button>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <div className="embedded">
                <span className="live-dot" /> YOUR APP. YOUR WORKFLOW.
                <p>
                  Connected support, without
                  <br />
                  the complexity.
                </p>
              </div>
              <div className="profile">
                <span className="avatar">{initials(me.user.name)}</span>
                <div>
                  <strong>{me.user.name}</strong>
                  <small>{me.user.role}</small>
                </div>
              </div>
            </div>
          </aside>
          <div className="shell">
            <header className="topbar">
              <div>
                Workspace <span>/</span>
                <strong>Cases</strong>
              </div>
              <div className="top-actions">
                <button
                  className="theme-toggle"
                  type="button"
                  aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
                  aria-pressed={theme === 'dark'}
                  onClick={toggleTheme}
                >
                  {theme === 'light' ? '☾ Dark mode' : '☀ Light mode'}
                </button>
              </div>
            </header>
            <main>
              <div className="page-heading">
                <div className="eyebrow">SERVICE DESK</div>
                <div className="heading-row">
                  <div>
                    <h1>Every case. Under control.</h1>
                    <p>A little clarity for your team's next big day.</p>
                  </div>
                  <button
                    className="button primary"
                    type="button"
                    onClick={() => {
                      setFormError('');
                      setCreating(true);
                    }}
                  >
                    ＋ New case
                  </button>
                </div>
              </div>
              {error && (
                <p className="cck-error" role="alert">
                  {error}
                </p>
              )}
              <section className="metrics" aria-label="Case statistics">
                {(
                  [
                    ['active', 'Active cases', 'Open, in progress and pending'],
                    ['pending', 'Waiting on customer', 'A conversation to continue'],
                    ['resolved', 'Resolved cases', 'Good work, all around'],
                    ['overdue', 'Past resolution target', 'Cases that need attention'],
                  ] as const
                ).map(([key, label, hint]) => (
                  <article key={key} className={key === 'overdue' ? 'sla-card' : ''}>
                    <div>
                      <span>{label}</span>
                    </div>
                    <strong>{stats[key]}</strong>
                    <small>{hint}</small>
                  </article>
                ))}
              </section>
              <section className="case-section">
                <div className="section-heading">
                  <div>
                    <h2>
                      {views.find(([key]) => key === view)?.[2]} <span>{list.total}</span>
                    </h2>
                    <p>The details that keep things moving.</p>
                  </div>
                  <button
                    className="button subtle"
                    type="button"
                    onClick={() => setRefresh((n) => n + 1)}
                  >
                    ↻ Refresh
                  </button>
                </div>
                <div className="toolbar">
                  <label className="search">
                    <span aria-hidden="true">⌕</span>
                    <input
                      type="search"
                      aria-label="Search cases"
                      placeholder="Search by title or case number…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                  <div className="filters">
                    <select
                      aria-label="Filter by status"
                      value={status}
                      onChange={(e) => {
                        setStatus(e.target.value);
                        setPage(1);
                      }}
                    >
                      <option value="">All statuses</option>
                      {me.statuses.map((s) => (
                        <option value={s} key={s}>
                          {labels[s]}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label="Filter by priority"
                      value={priority}
                      onChange={(e) => {
                        setPriority(e.target.value);
                        setPage(1);
                      }}
                    >
                      <option value="">All priorities</option>
                      {me.priorities.map((p) => (
                        <option value={p} key={p}>
                          {labels[p]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="table-wrap" aria-busy={loading}>
                  <table>
                    <thead>
                      <tr>
                        <th>CASE / SUBJECT</th>
                        <th>STATUS</th>
                        <th>PRIORITY</th>
                        <th>REQUESTER</th>
                        <th>UPDATED</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.items.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <span className="case-number">{item.number}</span>
                            <button
                              className="case-title"
                              type="button"
                              onClick={() => void openCase(item.id)}
                            >
                              {item.title}
                            </button>
                          </td>
                          <td>
                            <span className={`badge ${item.status}`}>• {labels[item.status]}</span>
                          </td>
                          <td>
                            <span className={`priority ${item.priority}`}>
                              {labels[item.priority]}
                            </span>
                          </td>
                          <td>
                            <span className="requester">
                              <span className="tiny-avatar">{initials(item.requesterName)}</span>
                              {item.requesterName}
                            </span>
                          </td>
                          <td>{date(item.updatedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!loading && !list.items.length && (
                    <div className="cck-empty">No cases match these filters.</div>
                  )}
                </div>
                <footer className="table-footer">
                  <span>{loading ? 'Loading cases…' : `${list.total} cases`}</span>
                  <div>
                    <button
                      className="button subtle"
                      type="button"
                      aria-label="Previous page"
                      disabled={page === 1 || loading}
                      onClick={() => setPage((n) => n - 1)}
                    >
                      ←
                    </button>
                    <span>Page {page}</span>
                    <button
                      className="button subtle"
                      type="button"
                      aria-label="Next page"
                      disabled={page * 8 >= list.total || loading}
                      onClick={() => setPage((n) => n + 1)}
                    >
                      →
                    </button>
                  </div>
                </footer>
              </section>
              <footer className="page-footer">
                <span>
                  <Logo small /> Made for a more human service desk.
                </span>
                <span>Powered by CookieCaseKit</span>
              </footer>
            </main>
          </div>
          {creating && (
            <Dialog title="Create a case" close={closeDialog}>
              <form onSubmit={create}>
                <label>
                  Subject
                  <input name="title" required maxLength={200} />
                </label>
                <label>
                  Description
                  <textarea name="description" required maxLength={20000} rows={5} />
                </label>
                <div className="form-grid">
                  <label>
                    Category
                    <select name="category">
                      {me.categories.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Priority
                    <select name="priority" defaultValue="normal">
                      {me.priorities.map((p) => (
                        <option value={p} key={p}>
                          {labels[p]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {formError && (
                  <p className="form-error" role="alert">
                    {formError}
                  </p>
                )}
                <div className="form-actions">
                  <button className="button primary" disabled={busy}>
                    Create case →
                  </button>
                </div>
              </form>
            </Dialog>
          )}
          {ticket && (
            <Dialog title={ticket.title} close={closeDialog}>
              <p className="eyebrow">{ticket.number}</p>
              <div className="detail-meta">
                <span className={`badge ${ticket.status}`}>{labels[ticket.status]}</span>
                <span>
                  {ticket.category} · {ticket.requesterName}
                </span>
                <span>Assigned: {ticket.assigneeId || 'Unassigned'}</span>
                <span>Target: {new Date(ticket.dueAt).toLocaleString()}</span>
              </div>
              <p className="description">{ticket.description}</p>
              {me.attachments && (
                <AttachmentPanel
                  key={ticket.id}
                  basePath={normalized}
                  caseId={ticket.id}
                  maxBytes={me.attachments.maxBytes}
                  staff={staff}
                  getToken={getToken}
                />
              )}
              {staff && (
                <form key={ticket.version} onSubmit={update}>
                  <div className="form-grid">
                    <label>
                      Status
                      <select name="status" defaultValue={ticket.status}>
                        {transitions[ticket.status].map((s) => (
                          <option value={s} key={s}>
                            {labels[s]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Priority
                      <select name="priority" defaultValue={ticket.priority}>
                        {me.priorities.map((p) => (
                          <option value={p} key={p}>
                            {labels[p]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="form-actions">
                    <button
                      className="button"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void mutate(async () => {
                          await api(`cases/${ticket.id}`, 'PATCH', {
                            version: ticket.version,
                            assigneeId: me.user.id,
                          });
                          await openCase(ticket.id);
                        })
                      }
                    >
                      Assign to me
                    </button>
                    <button className="button primary" disabled={busy}>
                      Save changes
                    </button>
                  </div>
                </form>
              )}
              <h3>Conversation</h3>
              <div>
                {ticket.comments.map((comment) => (
                  <div className={`comment ${comment.internal ? 'internal' : ''}`} key={comment.id}>
                    <strong>{comment.authorName}</strong>
                    <small>
                      {date(comment.createdAt)}
                      {comment.internal ? ' · Internal note' : ''}
                      {comment.source === 'email' ? ' · Email reply' : ''}
                    </small>
                    <p>{comment.body}</p>
                  </div>
                ))}
                {!ticket.comments.length && <p>No replies yet. Start the conversation.</p>}
              </div>
              <form onSubmit={reply}>
                <label>
                  Write a reply
                  <textarea name="body" required maxLength={10000} rows={3} />
                </label>
                <div className="form-actions">
                  {staff && (
                    <label className="checkbox">
                      <input name="internal" type="checkbox" />
                      Internal note
                    </label>
                  )}
                  <button className="button primary" disabled={busy}>
                    Send reply →
                  </button>
                </div>
              </form>
              {staff && (
                <details>
                  <summary>Case activity</summary>
                  {ticket.events.map((event) => (
                    <p key={event.id}>
                      {date(event.createdAt)} · {event.actorName} · {event.action}
                    </p>
                  ))}
                </details>
              )}
              {formError && (
                <p className="form-error" role="alert">
                  {formError}
                </p>
              )}
            </Dialog>
          )}
        </>
      )}
    </section>
  );
}
