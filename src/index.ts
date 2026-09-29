import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import nodemailer from 'nodemailer';
import { randomUUID } from 'node:crypto';
import { createInbound } from './inbound.js';
import { fileURLToPath } from 'node:url';
import { openDatabase, transaction } from './database.js';
import type { Case, Config, User, Priority, Status, CreateCaseInput, Requester } from './types.js';
export type * from './types.js';
const statuses: Status[] = ['open', 'in_progress', 'pending', 'resolved', 'closed'];
const priorities: Priority[] = ['low', 'normal', 'high', 'urgent'];
export class TicketingError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function fail(status: number, message: string): never {
  throw new TicketingError(status, message);
}
function text(value: unknown, name: string, max: number, optional = false): string {
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max)
    fail(400, `Invalid ${name}`);
  return value.trim();
}
function choice<T extends string>(value: unknown, values: T[], name: string): T {
  if (!values.includes(value as T)) fail(400, `Invalid ${name}`);
  return value as T;
}
function integer(value: unknown, name: string, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) fail(400, `Invalid ${name}`);
  return n;
}
const validEmail = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 254 &&
  /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
function validateUser(value: User | null): User {
  if (!value) fail(401, 'Authentication required');
  if (
    ![value.id, value.name, value.tenantId].every(
      (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200,
    ) ||
    !validEmail(value.email) ||
    !['requester', 'agent', 'admin'].includes(value.role)
  )
    fail(401, 'Invalid authenticated identity');
  return value;
}
/** Create a mountable Express router. Your host owns login and identity verification. */
export function createTicketing(config: Config) {
  if (!config?.database?.filename || typeof config.auth !== 'function')
    throw new Error('database.filename and auth are required');
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
    categories.some((c) => typeof c !== 'string' || !c.trim() || c.length > 80) ||
    new Set(categories).size !== categories.length
  )
    throw new Error('Invalid categories');
  const sla = { low: 168, normal: 72, high: 24, urgent: 4, ...config.slaHours };
  if (Object.values(sla).some((n) => !Number.isFinite(n) || n <= 0 || n > 87600))
    throw new Error('Invalid SLA hours');
  const accent = config.brand?.accent ?? '#315d48';
  if (!/^#[a-f\d]{6}$/i.test(accent)) throw new Error('brand.accent must be a six-digit hex color');
  if (config.email && (!validEmail(config.email.from) || !config.email.transport))
    throw new Error('Valid email.from and transport are required');
  if (config.email?.publicUrl && !/^https?:\/\//.test(config.email.publicUrl))
    throw new Error('email.publicUrl must use HTTP or HTTPS');
  if (config.email?.replyTo && !validEmail(config.email.replyTo))
    throw new Error('Invalid email.replyTo');
  const inboundConfig = config.email?.inbound;
  if (inboundConfig) {
    const connection = inboundConfig.connection;
    if (
      !connection?.host ||
      !connection.auth?.user ||
      (!connection.auth.pass && !connection.auth.accessToken)
    )
      throw new Error('IMAP host and authentication are required');
    if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535)
      throw new Error('Invalid IMAP port');
    if (connection.secure !== true && connection.doSTARTTLS !== true)
      throw new Error('IMAP requires TLS or mandatory STARTTLS');
    if (
      !Number.isFinite(inboundConfig.pollIntervalMs ?? 30000) ||
      (inboundConfig.pollIntervalMs ?? 30000) < 1000
    )
      throw new Error('inbound.pollIntervalMs must be at least 1000');
  }
  const interval = config.email?.pollIntervalMs ?? 30000;
  if (!Number.isFinite(interval) || interval < 1000)
    throw new Error('email.pollIntervalMs must be at least 1000');
  const db = openDatabase(config.database.filename);
  const router = express.Router();
  const logger = config.logger ?? console;
  const transport = config.email ? nodemailer.createTransport(config.email.transport) : null;
  let closed = false;
  let running: Promise<void> | undefined;
  function queue(ticket: Case, subject: string, body: string) {
    if (!transport) return;
    const link = config.email?.publicUrl
      ? `\n\n${config.email.publicUrl.replace(/\/$/, '')}/#case-${ticket.id}`
      : '';
    db.prepare(
      'INSERT INTO outbox (recipient, subject, body, nextAttempt, caseId, messageId) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      ticket.requesterEmail,
      `[${ticket.number}] ${subject}`,
      body +
        link +
        '\n\n--- CookieCaseKit reply ---\n' +
        (inboundConfig
          ? 'Reply above this line to add a public note to this case.'
          : 'Keep this case number for your records.'),
      new Date().toISOString(),
      ticket.id,
      `<${randomUUID()}@${config.email!.from.split('@')[1]}>`,
    );
  }
  async function sendBatch() {
    const rows = db
      .prepare(
        'SELECT * FROM outbox WHERE sentAt IS NULL AND attempts < 5 AND nextAttempt <= ? ORDER BY id LIMIT 25',
      )
      .all(new Date().toISOString());
    for (const row of rows) {
      try {
        // Give pre-migration queued messages stable IDs before the first post-upgrade send.
        const messageId = row.messageId
          ? String(row.messageId)
          : `<${randomUUID()}@${config.email!.from.split('@')[1]}>`;
        if (!row.messageId)
          db.prepare('UPDATE outbox SET messageId = ? WHERE id = ?').run(messageId, row.id);
        await transport!.sendMail({
          messageId,
          replyTo: config.email!.replyTo ?? config.email!.from,
          from: config.email!.from,
          to: String(row.recipient),
          subject: String(row.subject),
          text: String(row.body),
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        db.prepare('UPDATE outbox SET sentAt = ? WHERE id = ?').run(
          new Date().toISOString(),
          row.id,
        );
      } catch (error) {
        const attempts = Number(row.attempts) + 1;
        db.prepare('UPDATE outbox SET attempts = ?, nextAttempt = ? WHERE id = ?').run(
          attempts,
          new Date(Date.now() + 60000 * 2 ** attempts).toISOString(),
          row.id,
        );
        logger.error('CookieCaseKit email delivery failed', error);
      }
    }
  }
  function flushEmails(): Promise<void> {
    if (closed || !transport) return Promise.resolve();
    if (!running)
      running = sendBatch().finally(() => {
        running = undefined;
      });
    return running;
  }
  const timer = transport
    ? setInterval(() => {
        void flushEmails().catch((e) => logger.error('CookieCaseKit outbox worker failed', e));
      }, interval)
    : undefined;
  timer?.unref();
  const inbox = createInbound(db, inboundConfig, logger);
  router.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  router.use(async (req, res, next) => {
    res.locals.user = validateUser(await config.auth(req));
    next();
  });
  router.use(
    '/api',
    (req, _res, next) => {
      if (
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        (req.get('X-CookieCaseKit') !== '1' || !req.is('application/json'))
      )
        fail(403, 'JSON and X-CookieCaseKit: 1 are required');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        // Reject browser cross-origin writes even if host middleware enables permissive CORS.
        const origin = req.get('Origin');
        if (req.get('Sec-Fetch-Site') === 'cross-site')
          fail(403, 'Cross-origin writes are forbidden');
        if (origin) {
          let sameOrigin = false;
          try {
            sameOrigin = new URL(origin).origin === `${req.protocol}://${req.get('host')}`;
          } catch {
            /* Invalid and opaque origins are untrusted. */
          }
          if (!sameOrigin) fail(403, 'Cross-origin writes are forbidden');
        }
      }
      next();
    },
    express.json({ limit: '64kb' }),
  );
  function user(res: Response) {
    return res.locals.user as User;
  }
  function getCase(id: unknown, actor: User): Case {
    const row = db
      .prepare('SELECT * FROM cases WHERE id = ? AND tenantId = ?')
      .get(integer(id, 'case id'), actor.tenantId) as unknown as Case | undefined;
    if (!row || (actor.role === 'requester' && row.requesterId !== actor.id))
      fail(404, 'Case not found');
    return row;
  }
  function event(id: number, actor: User, action: string) {
    db.prepare('INSERT INTO events (caseId, actorName, action, createdAt) VALUES (?, ?, ?, ?)').run(
      id,
      actor.name,
      action,
      new Date().toISOString(),
    );
  }
  router.get('/api/me', (_req, res) =>
    res.json({
      user: user(res),
      brand: { name: config.brand?.name ?? 'CookieCaseKit', accent },
      categories,
      statuses,
      priorities,
    }),
  );
  router.get('/api/cases', (req, res) => {
    const actor = user(res);
    const where = ['tenantId = ?'];
    const params: (string | number)[] = [actor.tenantId];
    if (actor.role === 'requester') {
      where.push('requesterId = ?');
      params.push(actor.id);
    }
    if (req.query.status) {
      where.push('status = ?');
      params.push(choice(req.query.status, statuses, 'status'));
    }
    if (req.query.priority) {
      where.push('priority = ?');
      params.push(choice(req.query.priority, priorities, 'priority'));
    }
    if (req.query.assignee === 'me') {
      where.push('assigneeId = ?');
      params.push(actor.id);
    } else if (req.query.assignee !== undefined) fail(400, 'Invalid assignee filter');
    if (req.query.q) {
      const q = text(req.query.q, 'search', 200);
      where.push("(title LIKE ? ESCAPE '\\' OR number LIKE ? ESCAPE '\\')");
      const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      params.push(pattern, pattern);
    }
    const page = integer(req.query.page ?? 1, 'page', 1, 1000000);
    const limit = integer(req.query.limit ?? 20, 'limit', 1, 100);
    const clause = where.join(' AND ');
    const total = db
      .prepare(`SELECT count(*) AS total FROM cases WHERE ${clause}`)
      .get(...params)?.total;
    const items = db
      .prepare(
        `SELECT * FROM cases WHERE ${clause} ORDER BY updatedAt DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, (page - 1) * limit);
    res.json({ items, total, page, limit });
  });
  router.get('/api/stats', (_req, res) => {
    const actor = user(res);
    const scope = actor.role === 'requester' ? ' AND requesterId = ?' : '';
    const args = actor.role === 'requester' ? [actor.tenantId, actor.id] : [actor.tenantId];
    const row = db
      .prepare(
        `SELECT count(*) AS total, coalesce(sum(status NOT IN ('resolved','closed')),0) AS active, coalesce(sum(status = 'pending'),0) AS pending, coalesce(sum(status IN ('resolved','closed')),0) AS resolved, coalesce(sum(status NOT IN ('resolved','closed') AND dueAt < ?),0) AS overdue FROM cases WHERE tenantId = ?${scope}`,
      )
      .get(new Date().toISOString(), ...args);
    res.json(row);
  });
  /** Trusted server-side submission. This does not expose a public HTTP endpoint. */
  function createCase(body: CreateCaseInput, requester: Requester): Case {
    if (closed) throw new Error('CookieCaseKit is closed');
    const actor: User = {
      id: text(requester?.id, 'requester id', 200),
      name: text(requester?.name, 'requester name', 200),
      tenantId: text(requester?.tenantId, 'tenant id', 200),
      email: text(requester?.email, 'requester email', 254),
      role: 'requester',
    };
    if (!validEmail(actor.email)) fail(400, 'Invalid requester email');
    const title = text(body.title, 'title', 200);
    const description = text(body.description, 'description', 20000);
    const priority = choice(body.priority ?? 'normal', priorities, 'priority');
    const category = choice(body.category ?? categories[0], categories, 'category');
    const now = new Date().toISOString();
    const ticket = transaction(db, () => {
      const result = db
        .prepare(
          'INSERT INTO cases (tenantId,title,description,priority,category,requesterId,requesterName,requesterEmail,createdAt,updatedAt,dueAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          actor.tenantId,
          title,
          description,
          priority,
          category,
          actor.id,
          actor.name,
          actor.email,
          now,
          now,
          new Date(Date.now() + sla[priority] * 3600000).toISOString(),
        );
      const id = Number(result.lastInsertRowid);
      db.prepare('UPDATE cases SET number = ? WHERE id = ?').run(
        `CS-${String(id).padStart(5, '0')}`,
        id,
      );
      event(id, actor, 'Case created');
      const ticket = getCase(id, actor);
      queue(ticket, 'Case received', `${ticket.title}\n\nWe have received your request.`);
      return ticket;
    });
    return ticket;
  }
  router.post('/api/cases', (req, res) => {
    res.status(201).json(createCase(req.body ?? {}, user(res)));
  });
  router.get('/api/cases/:id', (req, res) => {
    const actor = user(res);
    const ticket = getCase(req.params.id, actor);
    const comments = db
      .prepare(
        `SELECT * FROM comments WHERE caseId = ?${actor.role === 'requester' ? ' AND internal = 0' : ''} ORDER BY id`,
      )
      .all(ticket.id)
      .map((c) => ({ ...c, internal: Boolean(c.internal) }));
    // Requesters do not receive staff audit history, which includes assignment details.
    const events =
      actor.role === 'requester'
        ? []
        : db.prepare('SELECT * FROM events WHERE caseId = ? ORDER BY id').all(ticket.id);
    res.json({ ...ticket, comments, events });
  });
  router.patch('/api/cases/:id', (req, res) => {
    const actor = user(res);
    if (actor.role === 'requester') fail(403, 'Agent role required');
    const body = req.body ?? {};
    const allowed = ['status', 'priority', 'category', 'assigneeId', 'version'];
    if (Object.keys(body).some((k) => !allowed.includes(k))) fail(400, 'Unknown update field');
    const version = integer(body.version, 'version');
    const ticket = transaction(db, () => {
      const current = getCase(req.params.id, actor);
      if (current.version !== version) fail(409, 'Case changed. Refresh before saving.');
      const status =
        body.status === undefined ? current.status : choice(body.status, statuses, 'status');
      const transitions: Record<Status, Status[]> = {
        open: ['in_progress', 'pending', 'resolved'],
        in_progress: ['open', 'pending', 'resolved'],
        pending: ['open', 'in_progress', 'resolved'],
        resolved: ['open', 'closed'],
        closed: ['open'],
      };
      if (status !== current.status && !transitions[current.status].includes(status))
        fail(409, `Cannot move from ${current.status} to ${status}`);
      const priority =
        body.priority === undefined
          ? current.priority
          : choice(body.priority, priorities, 'priority');
      const category =
        body.category === undefined
          ? current.category
          : choice(body.category, categories, 'category');
      const assigneeId =
        body.assigneeId === undefined
          ? current.assigneeId
          : body.assigneeId === null
            ? null
            : text(body.assigneeId, 'assigneeId', 200);
      // Agents claim/unassign themselves; admins can assign a host-system user ID.
      if (
        actor.role !== 'admin' &&
        assigneeId !== current.assigneeId &&
        ((assigneeId !== null && assigneeId !== actor.id) ||
          (assigneeId === null && current.assigneeId !== actor.id))
      )
        fail(403, 'Only admins can assign another agent');
      const dueAt =
        priority === current.priority
          ? current.dueAt
          : new Date(Date.parse(current.createdAt) + sla[priority] * 3600000).toISOString();
      db.prepare(
        'UPDATE cases SET status=?,priority=?,category=?,assigneeId=?,dueAt=?,updatedAt=?,version=version+1 WHERE id=?',
      ).run(status, priority, category, assigneeId, dueAt, new Date().toISOString(), current.id);
      for (const [key, value] of Object.entries({ status, priority, category, assigneeId }))
        if (current[key as keyof Case] !== value)
          event(
            current.id,
            actor,
            `${key}: ${current[key as keyof Case] ?? 'Unassigned'} → ${value ?? 'Unassigned'}`,
          );
      const updated = getCase(current.id, actor);
      if (current.status !== status)
        queue(
          updated,
          'Status updated',
          `${updated.title}\n\nStatus: ${status.replaceAll('_', ' ')}`,
        );
      return updated;
    });
    res.json(ticket);
  });
  router.post('/api/cases/:id/comments', (req, res) => {
    const actor = user(res);
    const body = text(req.body?.body, 'comment', 10000);
    if (req.body?.internal !== undefined && typeof req.body.internal !== 'boolean')
      fail(400, 'internal must be a boolean');
    const internal = req.body?.internal ?? false;
    if (internal && actor.role === 'requester') fail(403, 'Agent role required');
    const comment = transaction(db, () => {
      const ticket = getCase(req.params.id, actor);
      const now = new Date().toISOString();
      const result = db
        .prepare(
          'INSERT INTO comments (caseId,authorId,authorName,body,internal,createdAt) VALUES (?,?,?,?,?,?)',
        )
        .run(ticket.id, actor.id, actor.name, body, Number(internal), now);
      db.prepare('UPDATE cases SET updatedAt=?, version=version+1 WHERE id=?').run(now, ticket.id);
      if (!internal && actor.id !== ticket.requesterId)
        queue(ticket, 'New reply', `${actor.name} replied:\n\n${body}`);
      return {
        id: Number(result.lastInsertRowid),
        caseId: ticket.id,
        authorId: actor.id,
        authorName: actor.name,
        body,
        internal,
        source: 'web',
        createdAt: now,
      };
    });
    res.status(201).json(comment);
  });
  router.get('/brand.css', (_req, res) => {
    res.type('css').send(`:root{--accent:${accent}}`);
  });
  router.use('/api', (_req, _res) => fail(404, 'Endpoint not found'));
  if (config.ui !== false) {
    router.get('/', (req, res, next) => {
      if (!req.originalUrl.split('?')[0].endsWith('/')) return res.redirect(308, `${req.baseUrl}/`);
      next();
    });
    router.use(
      express.static(fileURLToPath(new URL('../public', import.meta.url)), {
        etag: false,
        maxAge: 0,
      }),
    );
  }
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      error instanceof TicketingError
        ? error.status
        : (error as { type?: string })?.type === 'entity.too.large'
          ? 413
          : error instanceof SyntaxError
            ? 400
            : 500;
    if (status === 500) logger.error('CookieCaseKit request failed', error);
    res.status(status).json({
      error:
        status === 500
          ? 'Internal server error'
          : status === 413
            ? 'Request too large'
            : error instanceof TicketingError
              ? error.message
              : 'Invalid JSON',
    });
  });
  const handler = express();
  handler.disable('x-powered-by');
  handler.use(router);
  return {
    router,
    handler,
    createCase,
    receiveEmail: inbox.receiveEmail,
    pollInbox: inbox.pollInbox,
    flushEmails,
    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      await inbox.close();
      await running;
      transport?.close();
      db.close();
    },
  };
}
