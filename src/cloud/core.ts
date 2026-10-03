import express from 'express';
import { cloudInbox, type CloudInboundConfig } from './inbound.js';
import { rateLimit, type Store } from 'express-rate-limit';
import type { Request } from 'express';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { atomic, documents, ConflictError, type CaseStore } from './store.js';
import type {
  Case,
  Comment,
  Event,
  User,
  Requester,
  CreateCaseInput,
  Priority,
  Status,
} from '../types.js';
import type { AttachmentStorage } from './storage.js';

export interface CloudConfig {
  /** Exact browser-facing origin when a reverse proxy rewrites the backend Host. */
  publicOrigin?: string;
  rateLimit?: { limit?: number; windowMs?: number; store?: Store };
  store: CaseStore;
  auth(req: Request): User | null | Promise<User | null>;
  categories?: string[];
  brand?: { name?: string; accent?: string };
  slaHours?: Partial<Record<Priority, number>>;
  email?: {
    from: string;
    replyTo?: string;
    /** Call pollInbox(tenant) from a trusted scheduler; no background timers are started. */
    inbound?: CloudInboundConfig;
    send(
      message: {
        from: string;
        to: string;
        subject: string;
        text: string;
        messageId: string;
        replyTo: string;
      },
      signal: AbortSignal,
    ): Promise<void | { messageId: string }>;
  };
  attachments?: { storage: AttachmentStorage; maxBytes?: number };
  logger?: { error(message: string, error?: unknown): void };
}
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}
const statuses: Status[] = ['open', 'in_progress', 'pending', 'resolved', 'closed'];
const priorities: Priority[] = ['low', 'normal', 'high', 'urgent'];
function text(v: unknown, label: string, max: number) {
  if (typeof v !== 'string' || !v.trim() || v.length > max || v.includes('\0'))
    fail(400, `Invalid ${label}`);
  return v.trim();
}
function integer(v: unknown, label: string, max = Number.MAX_SAFE_INTEGER) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) fail(400, `Invalid ${label}`);
  return n;
}
function choice<T extends string>(v: unknown, choices: T[], label: string): T {
  if (!choices.includes(v as T)) fail(400, `Invalid ${label}`);
  return v as T;
}
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const id = () => parseInt(randomBytes(6).toString('hex'), 16) + 1;
const email = (v: unknown) =>
  typeof v === 'string' && v.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(v);
function identity(v: User | null): User {
  if (!v) fail(401, 'Authentication required');
  text(v.id, 'identity', 200);
  text(v.tenantId, 'tenant', 200);
  text(v.name, 'name', 200);
  if (!email(v.email)) fail(401, 'Invalid identity');
  choice(v.role, ['requester', 'agent', 'admin'], 'role');
  return v;
}
const caseKey = (n: number) => `case-${String(n).padStart(15, '0')}`;
const childPrefix = (type: string, n: number) => `${type}-${n}-`;
const record = (v: unknown) => v as Record<string, unknown>;
const visible = (c: Case, u: User) =>
  c.tenantId === u.tenantId && (u.role !== 'requester' || c.requesterId === u.id);

/** Async cloud engine. Each mutation atomically commits case state, audit and queued email. No background timers. */
export function createCloudTicketing(config: CloudConfig) {
  if (!config?.store || typeof config.auth !== 'function')
    throw new Error('store and auth are required');
  let publicOrigin: string | undefined;
  if (config.publicOrigin !== undefined) {
    const url = new URL(config.publicOrigin);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error(
        'publicOrigin must be an HTTP(S) origin without credentials, path, query or hash',
      );
    publicOrigin = url.origin;
  }
  const { store } = config;
  const categories = config.categories ?? [
    'General',
    'Access & identity',
    'Infrastructure',
    'Billing',
    'Product',
  ];
  if (
    !categories.length ||
    categories.length > 50 ||
    new Set(categories).size !== categories.length
  )
    throw new Error('Invalid categories');
  categories.forEach((c) => text(c, 'category', 80));
  const sla = { low: 168, normal: 72, high: 24, urgent: 4, ...config.slaHours };
  if (Object.values(sla).some((n) => !Number.isFinite(n) || n <= 0 || n > 87600))
    throw new Error('Invalid SLA hours');
  const accent = config.brand?.accent ?? '#315d48';
  if (!/^#[a-f\d]{6}$/i.test(accent)) throw new Error('Invalid brand accent');
  if (
    config.email &&
    (!email(config.email.from) || !email(config.email.replyTo ?? config.email.from))
  )
    throw new Error('Invalid email configuration');
  const maxBytes = config.attachments?.maxBytes ?? 5 * 1024 * 1024;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 20 * 1024 * 1024)
    throw new Error('Attachment limit must be 1 byte to 20 MiB');
  let closed = false;
  const ensureOpen = () => {
    if (closed) throw new Error('CookieCaseKit is closed');
  };
  async function load(n: number, u: User) {
    const doc = await store.read(u.tenantId, caseKey(n));
    const c = doc?.value as unknown as Case;
    if (!c || !visible(c, u)) fail(404, 'Case not found');
    return c;
  }
  async function add(tx: Parameters<Parameters<typeof atomic>[2]>[0], key: string, value: unknown) {
    if (await tx.get(key)) throw new ConflictError('Identifier collision');
    tx.put(key, record(value));
  }
  async function queue(
    tx: Parameters<Parameters<typeof atomic>[2]>[0],
    c: Case,
    subject: string,
    body: string,
  ) {
    if (!config.email) return;
    await add(tx, `outbox-${randomUUID()}`, {
      caseId: c.id,
      to: c.requesterEmail,
      subject: `[${c.number}] ${subject}`,
      text: body + '\n\n--- CookieCaseKit reply ---\nReply above this line to add a public note.',
      messageId: `<${randomUUID()}@${config.email.from.split('@')[1]}>`,
      attempts: 0,
      nextAttempt: Date.now(),
      leaseUntil: 0,
      sentAt: null,
    });
  }
  async function event(
    tx: Parameters<Parameters<typeof atomic>[2]>[0],
    c: Case,
    u: User,
    action: string,
  ) {
    const e: Event = {
      id: id(),
      caseId: c.id,
      actorName: u.name,
      action,
      createdAt: new Date().toISOString(),
    };
    await add(tx, childPrefix('event', c.id) + e.id, e);
  }
  async function createCase(
    input: CreateCaseInput,
    requester: Requester,
    options: { idempotencyKey?: string } = {},
  ) {
    ensureOpen();
    const u = identity({ ...requester, role: 'requester' });
    const title = text(input?.title, 'title', 200),
      description = text(input?.description, 'description', 20000);
    const category = choice(input.category ?? categories[0], categories, 'category'),
      priority = choice(input.priority ?? 'normal', priorities, 'priority');
    const key = options.idempotencyKey
      ? `request-${digest(text(options.idempotencyKey, 'idempotency key', 200))}`
      : null;
    const fingerprint = digest(
      JSON.stringify({ title, description, category, priority, requester: u }),
    );
    const n = id(),
      now = new Date().toISOString();
    return atomic(store, u.tenantId, async (tx) => {
      if (key) {
        const prior = await tx.get(key);
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            fail(409, 'Idempotency key reused with different input');
          const c = await tx.get(caseKey(Number(prior.caseId)));
          if (!c) throw new Error('Missing idempotent case');
          return c as unknown as Case;
        }
      }
      const c: Case = {
        id: n,
        number: `CS-${n}`,
        tenantId: u.tenantId,
        title,
        description,
        category,
        priority,
        status: 'open',
        requesterId: u.id,
        requesterName: u.name,
        requesterEmail: u.email,
        assigneeId: null,
        createdAt: now,
        updatedAt: now,
        dueAt: new Date(Date.now() + sla[priority] * 3600000).toISOString(),
        version: 1,
      };
      await add(tx, caseKey(n), c);
      await event(tx, c, u, 'Case created');
      await queue(tx, c, 'Case received', `${title}\n\nWe have received your request.`);
      if (key) tx.put(key, { caseId: n, fingerprint });
      return c;
    });
  }
  async function updateCase(n: number, input: Record<string, unknown>, actor: User) {
    ensureOpen();
    const u = identity(actor);
    if (u.role === 'requester') fail(403, 'Agent role required');
    if (
      Object.keys(input).some(
        (k) => !['version', 'status', 'priority', 'category', 'assigneeId'].includes(k),
      )
    )
      fail(400, 'Unknown update field');
    const version = integer(input.version, 'version');
    return atomic(store, u.tenantId, async (tx) => {
      const c = (await tx.get(caseKey(n))) as unknown as Case;
      if (!c || !visible(c, u)) fail(404, 'Case not found');
      if (c.version !== version) fail(409, 'Case changed. Refresh before saving.');
      const next = { ...c };
      if (input.status !== undefined) {
        next.status = choice(input.status, statuses, 'status');
        const transitions: Record<Status, Status[]> = {
          open: ['in_progress', 'pending', 'resolved'],
          in_progress: ['open', 'pending', 'resolved'],
          pending: ['open', 'in_progress', 'resolved'],
          resolved: ['open', 'closed'],
          closed: ['open'],
        };
        if (next.status !== c.status && !transitions[c.status].includes(next.status))
          fail(409, 'Invalid status transition');
      }
      if (input.priority !== undefined) {
        next.priority = choice(input.priority, priorities, 'priority');
        next.dueAt = new Date(Date.parse(c.createdAt) + sla[next.priority] * 3600000).toISOString();
      }
      if (input.category !== undefined)
        next.category = choice(input.category, categories, 'category');
      if (input.assigneeId !== undefined) {
        next.assigneeId =
          input.assigneeId === null ? null : text(input.assigneeId, 'assignee', 200);
        if (
          u.role !== 'admin' &&
          next.assigneeId !== c.assigneeId &&
          ((next.assigneeId !== null && next.assigneeId !== u.id) ||
            (next.assigneeId === null && c.assigneeId !== u.id))
        )
          fail(403, 'Only admins can assign another agent');
      }
      for (const field of ['status', 'priority', 'category', 'assigneeId'] as const)
        if (next[field] !== c[field])
          await event(
            tx,
            c,
            u,
            `${field}: ${c[field] ?? 'Unassigned'} → ${next[field] ?? 'Unassigned'}`,
          );
      next.version++;
      next.updatedAt = new Date().toISOString();
      tx.put(caseKey(n), record(next));
      if (next.status !== c.status)
        await queue(tx, next, 'Status updated', `${next.title}\n\nStatus: ${next.status}`);
      return next;
    });
  }
  async function addComment(n: number, input: { body: string; internal?: boolean }, actor: User) {
    ensureOpen();
    const u = identity(actor);
    const body = text(input.body, 'comment', 10000);
    if (input.internal !== undefined && typeof input.internal !== 'boolean')
      fail(400, 'Invalid internal flag');
    const internal = input.internal ?? false;
    if (internal && u.role === 'requester') fail(403, 'Agent role required');
    return atomic(store, u.tenantId, async (tx) => {
      const c = (await tx.get(caseKey(n))) as unknown as Case;
      if (!c || !visible(c, u)) fail(404, 'Case not found');
      const now = new Date().toISOString();
      const comment: Comment = {
        id: id(),
        caseId: n,
        authorId: u.id,
        authorName: u.name,
        body,
        internal,
        createdAt: now,
        source: 'web',
      };
      await add(tx, childPrefix('comment', n) + comment.id, comment);
      tx.put(caseKey(n), record({ ...c, version: c.version + 1, updatedAt: now }));
      if (!internal && (u.role !== 'requester' || u.id !== c.requesterId))
        await queue(tx, c, 'New reply', `${u.name} replied:\n\n${body}`);
      return comment;
    });
  }
  async function detail(n: number, u: User) {
    ensureOpen();
    u = identity(u);
    const c = await load(n, u);
    const comments: Comment[] = [],
      events: Event[] = [];
    for await (const d of documents(store, u.tenantId, childPrefix('comment', n))) {
      const v = d.value as unknown as Comment;
      if (!v.internal || u.role !== 'requester') comments.push(v);
    }
    if (u.role !== 'requester')
      for await (const d of documents(store, u.tenantId, childPrefix('event', n)))
        events.push(d.value as unknown as Event);
    comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
    events.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
    return { ...c, comments, events };
  }
  /** Invoke from a trusted scheduler for each configured tenant. Delivery is at least once. */
  async function flushEmails(tenant: string, limit = 25) {
    ensureOpen();
    text(tenant, 'tenant', 200);
    integer(limit, 'limit', 100);
    if (!config.email) return { sent: 0, failed: 0 };
    let sent = 0,
      failed = 0,
      claimed = 0;
    for await (const doc of documents(store, tenant, 'outbox-')) {
      if (claimed >= limit) break;
      const now = Date.now();
      if (
        doc.value.sentAt ||
        Number(doc.value.nextAttempt) > now ||
        Number(doc.value.leaseUntil) > now ||
        Number(doc.value.attempts) >= 5
      )
        continue;
      const owner = randomUUID();
      const job = await atomic(store, tenant, async (tx) => {
        const v = await tx.get(doc.key);
        if (
          !v ||
          v.sentAt ||
          Number(v.nextAttempt) > Date.now() ||
          Number(v.leaseUntil) > Date.now() ||
          Number(v.attempts) >= 5
        )
          return null;
        const next: Record<string, unknown> = {
          ...v,
          owner,
          leaseUntil: Date.now() + 300000,
          attempts: Number(v.attempts) + 1,
        };
        tx.put(doc.key, next);
        return next;
      });
      if (!job) continue;
      claimed++;
      let success = false;
      try {
        const delivered = await config.email.send(
          {
            from: config.email.from,
            replyTo: config.email.replyTo ?? config.email.from,
            to: String(job.to),
            subject: String(job.subject),
            text: String(job.text),
            messageId: String(job.messageId),
          },
          AbortSignal.timeout(60000),
        );
        if (delivered?.messageId) {
          await atomic(store, tenant, async (tx) => {
            const current = await tx.get(doc.key);
            if (current?.owner === owner)
              tx.put(doc.key, { ...current, deliveredMessageId: delivered.messageId });
          });
        }
        success = true;
        sent++;
      } catch (e) {
        failed++;
        config.logger?.error('CookieCaseKit email delivery failed', e);
      }
      await atomic(store, tenant, async (tx) => {
        const current = await tx.get(doc.key);
        if (!current || current.owner !== owner) return;
        tx.put(doc.key, {
          ...current,
          leaseUntil: 0,
          owner: null,
          sentAt: success ? new Date().toISOString() : null,
          nextAttempt: Date.now() + 60000 * 2 ** Number(current.attempts),
        });
      });
    }
    return { sent, failed };
  }
  /** Export confirmed deliveries to an idempotent audit sink, independently of SMTP retries. */
  async function syncSentEmails(
    tenant: string,
    sink: (message: {
      to: string;
      subject: string;
      text: string;
      messageId: string;
      sentAt: string;
    }) => Promise<unknown>,
    limit = 100,
  ) {
    ensureOpen();
    text(tenant, 'tenant', 200);
    integer(limit, 'limit', 100);
    let synced = 0;
    for await (const doc of documents(store, tenant, 'outbox-')) {
      if (synced >= limit) break;
      if (!doc.value.sentAt || doc.value.activitySyncedAt) continue;
      await sink({
        to: String(doc.value.to),
        subject: String(doc.value.subject),
        text: String(doc.value.text),
        messageId: String(doc.value.deliveredMessageId || doc.value.messageId),
        sentAt: String(doc.value.sentAt),
      });
      await atomic(store, tenant, async (tx) => {
        const current = await tx.get(doc.key);
        if (current?.sentAt === doc.value.sentAt)
          tx.put(doc.key, { ...current, activitySyncedAt: new Date().toISOString() });
      });
      synced++;
    }
    return { synced };
  }
  async function receiveEmail(tenant: string, source: string | Buffer) {
    text(tenant, 'tenant', 200);
    if (Buffer.byteLength(source) > 1024 * 1024)
      return { status: 'ignored', reason: 'message_too_large' };
    let mail;
    try {
      mail = await simpleParser(source, {
        skipTextToHtml: true,
        skipImageLinks: true,
        maxHtmlLengthToParse: 1024 * 1024,
      });
    } catch {
      return { status: 'ignored', reason: 'malformed_message' };
    }
    const mids = mail.subject?.toUpperCase().match(/\bCS-\d+\b/g) ?? [];
    const numbers = [...new Set(mids)];
    const from = mail.from?.value ?? [];
    if (
      numbers.length !== 1 ||
      from.length !== 1 ||
      !email(from[0].address) ||
      !mail.messageId ||
      !/^<[^<>\s]{1,990}>$/.test(mail.messageId)
    )
      return { status: 'ignored', reason: 'invalid_thread' };
    if (
      (mail.headers.get('auto-submitted') && mail.headers.get('auto-submitted') !== 'no') ||
      /^(bulk|list|junk)$/i.test(String(mail.headers.get('precedence') ?? '')) ||
      mail.headers.has('list-id')
    )
      return { status: 'ignored', reason: 'automated_message' };
    const n = Number(numbers[0].slice(3));
    if (!Number.isSafeInteger(n) || n < 1) return { status: 'ignored', reason: 'invalid_case' };
    const refs = [
      mail.inReplyTo,
      ...(Array.isArray(mail.references) ? mail.references : [mail.references]),
    ].filter(Boolean);
    if (!refs.length || refs.length > 100)
      return { status: 'ignored', reason: 'invalid_references' };
    let matched = false;
    for await (const d of documents(store, tenant, 'outbox-'))
      if (
        d.value.caseId === n &&
        String(d.value.to).toLowerCase() === from[0].address!.toLowerCase() &&
        (refs.includes(String(d.value.messageId)) ||
          refs.includes(String(d.value.deliveredMessageId)))
      ) {
        matched = true;
        break;
      }
    if (!matched) return { status: 'ignored', reason: 'unrecognized_thread_or_sender' };
    const body = (mail.text ?? '')
      .split(/\r?\n/)
      .reduce<{ lines: string[]; stop: boolean }>(
        (acc, line) => {
          if (
            /^\s*(?:On .+wrote:|[-_]{2,}\s*Original Message|--- CookieCaseKit reply ---)/i.test(
              line,
            )
          )
            acc.stop = true;
          if (!acc.stop && !/^\s*>/.test(line)) acc.lines.push(line);
          return acc;
        },
        { lines: [], stop: false },
      )
      .lines.join('\n')
      .trim();
    if (!body || body.length > 10000) return { status: 'ignored', reason: 'invalid_body' };
    return atomic(store, tenant, async (tx) => {
      const key = `inbound-${digest(mail.messageId!)}`;
      const old = await tx.get(key);
      if (old)
        return old.caseId === n
          ? { status: 'duplicate', caseId: n, commentId: old.commentId }
          : { status: 'ignored', reason: 'message_id_conflict' };
      const c = (await tx.get(caseKey(n))) as unknown as Case;
      if (!c || c.requesterEmail.toLowerCase() !== from[0].address!.toLowerCase())
        return { status: 'ignored', reason: 'invalid_sender' };
      const comment: Comment = {
        id: id(),
        caseId: n,
        authorId: c.requesterId,
        authorName: c.requesterName,
        body,
        internal: false,
        createdAt: new Date().toISOString(),
        source: 'email',
      };
      await add(tx, childPrefix('comment', n) + comment.id, comment);
      tx.put(key, { caseId: n, commentId: comment.id });
      tx.put(caseKey(n), record({ ...c, updatedAt: comment.createdAt, version: c.version + 1 }));
      await event(
        tx,
        c,
        {
          id: c.requesterId,
          name: c.requesterName,
          email: c.requesterEmail,
          tenantId: tenant,
          role: 'requester',
        },
        'Email reply added',
      );
      return { status: 'accepted', caseId: n, commentId: comment.id };
    });
  }
  const inbox = cloudInbox(store, config.email?.inbound, receiveEmail);
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    });
    next();
  });
  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      ...config.rateLimit,
    }),
  );
  router.use(async (req, res, next) => {
    ensureOpen();
    res.locals.user = identity(await config.auth(req));
    next();
  });
  router.use((req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('X-CookieCaseKit') !== '1') fail(403, 'X-CookieCaseKit: 1 required');
      if (req.get('Sec-Fetch-Site') === 'cross-site')
        fail(403, 'Cross-origin writes are forbidden');
      const origin = req.get('Origin');
      if (origin) {
        let same = false;
        try {
          same =
            new URL(origin).origin === (publicOrigin ?? `${req.protocol}://${req.get('host')}`);
        } catch {}
        if (!same) fail(403, 'Cross-origin writes are forbidden');
      }
      if (!req.path.endsWith('/attachments') && !req.is('application/json'))
        fail(403, 'JSON required');
    }
    next();
  });
  router.use(express.json({ limit: '64kb' }));
  router.get('/api/me', (_req, res) =>
    res.json({
      user: res.locals.user,
      brand: { name: config.brand?.name ?? 'CookieCaseKit', accent },
      categories,
      statuses,
      priorities,
      ...(config.attachments ? { attachments: { maxBytes } } : {}),
    }),
  );
  router.post('/api/cases', async (req, res) =>
    res
      .status(201)
      .json(
        await createCase(req.body, res.locals.user, { idempotencyKey: req.get('Idempotency-Key') }),
      ),
  );
  router.get('/api/cases/:id', async (req, res) =>
    res.json(await detail(integer(req.params.id, 'case id'), res.locals.user)),
  );
  router.patch('/api/cases/:id', async (req, res) =>
    res.json(await updateCase(integer(req.params.id, 'case id'), req.body, res.locals.user)),
  );
  router.post('/api/cases/:id/comments', async (req, res) =>
    res
      .status(201)
      .json(await addComment(integer(req.params.id, 'case id'), req.body, res.locals.user)),
  );
  router.get('/api/cases', async (req, res) => {
    const u = res.locals.user as User;
    const page = integer(req.query.page ?? 1, 'page', 1000000),
      limit = integer(req.query.limit ?? 20, 'limit', 100);
    const status = req.query.status ? choice(req.query.status, statuses, 'status') : undefined,
      priority = req.query.priority
        ? choice(req.query.priority, priorities, 'priority')
        : undefined;
    const q = req.query.q ? text(req.query.q, 'search', 200).toLowerCase() : '';
    if (req.query.assignee !== undefined && req.query.assignee !== 'me')
      fail(400, 'Invalid assignee');
    const items: Case[] = [];
    let total = 0;
    const keep = page * limit;
    for await (const d of documents(store, u.tenantId, 'case-')) {
      const c = d.value as unknown as Case;
      if (
        !visible(c, u) ||
        (status && c.status !== status) ||
        (priority && c.priority !== priority) ||
        (req.query.assignee === 'me' && c.assigneeId !== u.id) ||
        (q && !`${c.title}\n${c.number}`.toLowerCase().includes(q))
      )
        continue;
      total++;
      items.push(c);
      items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id);
      if (items.length > keep) items.pop();
    }
    res.json({ items: items.slice((page - 1) * limit), total, page, limit });
  });
  router.get('/api/stats', async (_req, res) => {
    const u = res.locals.user as User;
    const stats = { total: 0, active: 0, pending: 0, resolved: 0, overdue: 0 };
    for await (const d of documents(store, u.tenantId, 'case-')) {
      const c = d.value as unknown as Case;
      if (!visible(c, u)) continue;
      stats.total++;
      if (['resolved', 'closed'].includes(c.status)) stats.resolved++;
      else {
        stats.active++;
        if (c.dueAt < new Date().toISOString()) stats.overdue++;
      }
      if (c.status === 'pending') stats.pending++;
    }
    res.json(stats);
  });
  // Uploads remain private and pending until a trusted malware scanner explicitly approves them.
  router.post(
    '/api/cases/:id/attachments',
    express.raw({ type: 'application/octet-stream', limit: maxBytes }),
    async (req, res) => {
      if (!config.attachments) fail(404, 'Attachments are not configured');
      const u = res.locals.user as User;
      const n = integer(req.params.id, 'case id');
      await load(n, u);
      if (!Buffer.isBuffer(req.body) || !req.body.length) fail(400, 'Send binary attachment data');
      let decodedName: string;
      try {
        decodedName = decodeURIComponent(req.get('X-Filename') ?? '');
      } catch {
        fail(400, 'Invalid filename');
      }
      const name = text(decodedName, 'filename', 200).replace(/[\\/\r\n]/g, '_');
      const internal = req.get('X-Internal') === 'true';
      if (internal && u.role === 'requester') fail(403, 'Agent role required');
      const attachmentId = randomUUID(),
        key = `${digest(u.tenantId)}/${n}/${attachmentId}`;
      await config.attachments.storage.put(key, req.body);
      const metadata = {
        id: attachmentId,
        caseId: n,
        name,
        size: Buffer.byteLength(req.body),
        key,
        internal,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      try {
        await atomic(store, u.tenantId, async (tx) => {
          const c = (await tx.get(caseKey(n))) as unknown as Case;
          if (!c || !visible(c, u)) fail(404, 'Case not found');
          await add(tx, childPrefix('attachment', n) + attachmentId, metadata);
          await event(tx, c, u, 'Attachment uploaded (pending scan)');
        });
      } catch (e) {
        await config.attachments.storage.delete(key).catch(() => {});
        throw e;
      }
      res.status(201).json({ ...metadata, key: undefined });
    },
  );
  router.get('/api/cases/:id/attachments', async (req, res) => {
    const u = res.locals.user as User,
      n = integer(req.params.id, 'case id');
    await load(n, u);
    const items = [];
    for await (const d of documents(store, u.tenantId, childPrefix('attachment', n)))
      if (!d.value.internal || u.role !== 'requester') items.push({ ...d.value, key: undefined });
    res.json({ items });
  });
  router.get('/api/cases/:id/attachments/:attachmentId', async (req, res) => {
    if (!config.attachments) fail(404, 'Attachments are not configured');
    const u = res.locals.user as User,
      n = integer(req.params.id, 'case id');
    await load(n, u);
    const attachmentId = text(req.params.attachmentId, 'attachment id', 36);
    if (!/^[a-f0-9-]{36}$/.test(attachmentId)) fail(400, 'Invalid attachment id');
    const doc = await store.read(u.tenantId, childPrefix('attachment', n) + attachmentId);
    const a = doc?.value;
    if (!a || (a.internal && u.role === 'requester')) fail(404, 'Attachment not found');
    if (a.status !== 'clean') fail(409, 'Attachment is awaiting approval or was rejected');
    const data = await config.attachments.storage.get(String(a.key), maxBytes);
    res
      .set({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(String(a.name))}`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
      })
      .send(data);
  });
  async function approveAttachment(
    tenant: string,
    n: number,
    attachmentId: string,
    result: 'clean' | 'rejected',
  ) {
    if (!['clean', 'rejected'].includes(result)) throw new Error('Invalid scan result');
    await atomic(store, tenant, async (tx) => {
      const key = childPrefix('attachment', n) + attachmentId,
        a = await tx.get(key);
      if (!a) fail(404, 'Attachment not found');
      tx.put(key, { ...a, status: result });
    });
  }
  router.use((_req, _res) => fail(404, 'Endpoint not found'));
  router.use(
    (error: unknown, _req: Request, res: express.Response, _next: express.NextFunction) => {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof ConflictError
            ? 409
            : (error as { type?: string })?.type === 'entity.too.large'
              ? 413
              : error instanceof SyntaxError
                ? 400
                : 500;
      if (status === 500) config.logger?.error('CookieCaseKit cloud request failed', error);
      res.status(status).json({
        error:
          status === 500
            ? 'Internal server error'
            : status === 413
              ? 'Request too large'
              : error instanceof Error
                ? error.message
                : 'Invalid request',
      });
    },
  );
  return {
    router,
    createCase,
    updateCase,
    addComment,
    getCase: detail,
    flushEmails,
    syncSentEmails,
    receiveEmail,
    pollInbox: inbox.pollInbox,
    approveAttachment,
    async close() {
      closed = true;
      await inbox.close();
      await store.close?.();
    },
  };
}
