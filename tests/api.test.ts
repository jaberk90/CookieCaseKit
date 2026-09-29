import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTicketing, type User } from '../src/index.js';
const alice: User = {
  id: 'alice',
  name: 'Alice',
  email: 'alice@example.com',
  tenantId: 'one',
  role: 'requester',
};
const agent: User = { ...alice, id: 'agent', name: 'Agent', role: 'agent' };
const users: Record<string, User> = {
  alice,
  agent,
  bob: { ...alice, id: 'bob' },
  outsider: { ...agent, tenantId: 'two' },
  admin: { ...agent, role: 'admin' },
};
function fixture(filename = ':memory:', email = false) {
  const crm = createTicketing({
    database: { filename },
    auth: (req) => users[req.get('x-user') ?? ''] ?? null,
    ...(email
      ? { email: { from: 'help@example.com', transport: { jsonTransport: true } as never } }
      : {}),
  });
  const app = express();
  app.use('/support', crm.router);
  function api(method: 'get' | 'post' | 'patch', path: string, user = 'alice', body?: unknown) {
    const r = request(app)
      [method](`/support/api${path}`)
      .set('x-user', user)
      .set('X-CookieCaseKit', '1');
    return body === undefined ? r : r.send(body as object);
  }
  const create = () =>
    api('post', '/cases', 'alice', {
      title: 'Something broke',
      description: 'Please help',
      priority: 'high',
    });
  return { crm, app, api, create };
}
test('requires verified identities and authenticates static UI', async (t) => {
  const f = fixture();
  t.after(() => f.crm.close());
  await f.api('get', '/cases', '').expect(401);
  await request(f.app).get('/support/').expect(401);
  await request(f.app)
    .get('/support/')
    .set('x-user', 'alice')
    .expect(200)
    .expect('Content-Type', /html/);
  await request(f.app)
    .get('/support')
    .set('x-user', 'alice')
    .expect(308)
    .expect('Location', '/support/');
});
test('creates, filters and paginates persistent cases with server-owned identity', async (t) => {
  const f = fixture();
  t.after(() => f.crm.close());
  const first = (await f.create().expect(201)).body;
  assert.equal(first.number, 'CS-00001');
  assert.equal(first.requesterId, 'alice');
  await f
    .api('post', '/cases', 'alice', {
      title: 'Database 100% outage',
      description: 'Issue',
      tenantId: 'two',
      requesterId: 'bob',
    })
    .expect(201);
  const list = (await f.api('get', '/cases?limit=1&page=2').expect(200)).body;
  assert.equal(list.total, 2);
  assert.equal(list.items.length, 1);
  assert.equal((await f.api('get', '/cases?q=100%25')).body.total, 1);
  assert.equal((await f.api('get', '/cases?priority=high')).body.total, 1);
  assert.equal((await f.api('get', '/stats')).body.active, 2);
  await f.api('get', '/cases?limit=101').expect(400);
  await f.api('get', '/cases?status=invalid').expect(400);
});
test('enforces requester ownership and tenant isolation on every resource', async (t) => {
  const f = fixture();
  t.after(() => f.crm.close());
  const id = (await f.create()).body.id;
  for (const who of ['bob', 'outsider']) {
    assert.equal((await f.api('get', '/cases', who)).body.total, 0);
    assert.equal((await f.api('get', '/stats', who)).body.total, 0);
    await f.api('get', `/cases/${id}`, who).expect(404);
    await f.api('post', `/cases/${id}/comments`, who, { body: 'No access' }).expect(404);
  }
  await f.api('patch', `/cases/${id}`, 'outsider', { status: 'resolved', version: 1 }).expect(404);
  await f.api('patch', `/cases/${id}`, 'alice', { status: 'resolved', version: 1 }).expect(403);
  await f.api('get', `/cases/${id}`, 'agent').expect(200);
});
test('validates transitions, assignment and optimistic concurrency; records history', async (t) => {
  const f = fixture();
  t.after(() => f.crm.close());
  const id = (await f.create()).body.id;
  await f.api('patch', `/cases/${id}`, 'agent', { status: 'closed', version: 1 }).expect(409);
  await f.api('patch', `/cases/${id}`, 'agent', { assigneeId: 'other', version: 1 }).expect(403);
  const updated = (
    await f
      .api('patch', `/cases/${id}`, 'agent', {
        status: 'in_progress',
        assigneeId: 'agent',
        version: 1,
      })
      .expect(200)
  ).body;
  assert.equal(updated.version, 2);
  await f.api('patch', `/cases/${id}`, 'agent', { status: 'resolved', version: 1 }).expect(409);
  await f.api('patch', `/cases/${id}`, 'agent', { requesterId: 'hacker', version: 2 }).expect(400);
  await f
    .api('patch', `/cases/${id}`, 'admin', { status: 'resolved', assigneeId: 'other', version: 2 })
    .expect(200);
  const details = (await f.api('get', `/cases/${id}`, 'agent')).body;
  assert.ok(details.events.some((e: { action: string }) => e.action.includes('in_progress')));
  assert.deepEqual((await f.api('get', `/cases/${id}`, 'alice')).body.events, []);
});
test('internal notes never leak to requesters and comments invalidate stale updates', async (t) => {
  const f = fixture();
  t.after(() => f.crm.close());
  const id = (await f.create()).body.id;
  await f
    .api('post', `/cases/${id}/comments`, 'alice', { body: 'Secret', internal: true })
    .expect(403);
  await f
    .api('post', `/cases/${id}/comments`, 'agent', {
      body: 'Private investigation',
      internal: true,
    })
    .expect(201);
  await f
    .api('post', `/cases/${id}/comments`, 'agent', { body: 'We are on it', internal: false })
    .expect(201);
  const publicCase = (await f.api('get', `/cases/${id}`)).body;
  assert.equal(publicCase.comments.length, 1);
  assert.equal(publicCase.comments[0].internal, false);
  assert.equal((await f.api('get', `/cases/${id}`, 'agent')).body.comments.length, 2);
  await f.api('patch', `/cases/${id}`, 'agent', { status: 'pending', version: 1 }).expect(409);
});
test('rejects malformed input and browser-simple cross-origin writes', async (t) => {
  const f = fixture();
  t.after(() => f.crm.close());
  await f.api('post', '/cases', 'alice', { title: '', description: 'X' }).expect(400);
  await f
    .api('post', '/cases', 'alice', { title: 'X', description: 'X', priority: 'critical' })
    .expect(400);
  await request(f.app)
    .post('/support/api/cases')
    .set('x-user', 'alice')
    .send({ title: 'X', description: 'X' })
    .expect(403);
  await request(f.app)
    .post('/support/api/cases')
    .set('x-user', 'alice')
    .set('X-CookieCaseKit', '1')
    .type('form')
    .send('title=X')
    .expect(403);
  await request(f.app)
    .post('/support/api/cases')
    .set('x-user', 'alice')
    .set('X-CookieCaseKit', '1')
    .type('json')
    .send('{broken')
    .expect(400);
  await f
    .api('post', '/cases', 'alice', { title: 'X', description: 'x'.repeat(70000) })
    .expect(413);
  await f.api('get', '/cases/0').expect(400);
  await f.api('get', '/missing').expect(404);
});
test('persists cases and queued mail across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cookiecasekit-'));
  const file = join(dir, 'test.db');
  try {
    const first = fixture(file, true);
    await first.create().expect(201);
    await first.crm.close();
    const second = fixture(file, true);
    try {
      assert.equal((await second.api('get', '/cases')).body.total, 1);
      await Promise.all([second.crm.flushEmails(), second.crm.flushEmails()]);
    } finally {
      await second.crm.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('fails fast for invalid configuration and invalid host identities', async () => {
  assert.throws(() =>
    createTicketing({ database: { filename: ':memory:' }, auth: () => alice, categories: [] }),
  );
  assert.throws(() =>
    createTicketing({
      database: { filename: ':memory:' },
      auth: () => alice,
      slaHours: { urgent: -1 },
    }),
  );
  const crm = createTicketing({
    database: { filename: ':memory:' },
    auth: () => ({ ...alice, role: 'owner' as never }),
  });
  const app = express();
  app.use(crm.router);
  try {
    await request(app).get('/api/me').expect(401);
  } finally {
    await crm.close();
  }
});
test('mail is transactional, private notes are excluded, and failures are retried durably', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = await mkdtemp(join(tmpdir(), 'cookiecasekit-mail-'));
  const file = join(dir, 'test.db');
  let deliveries = 0;
  let failures = 0;
  const crm = createTicketing({
    database: { filename: file },
    auth: (req) => users[req.get('x-user') ?? 'alice'],
    logger: {
      error: () => {
        failures++;
      },
    },
    email: {
      from: 'help@example.com',
      transport: {
        name: 'failing-test',
        version: '1',
        send: (_mail: unknown, callback: (error: Error) => void) => {
          deliveries++;
          callback(new Error('SMTP offline'));
        },
      } as never,
    },
  });
  const app = express();
  app.use(crm.router);
  const db = new DatabaseSync(file);
  const post = (path: string, who: string, body: object) =>
    request(app)
      .post('/api' + path)
      .set('x-user', who)
      .set('X-CookieCaseKit', '1')
      .send(body);
  try {
    const ticket = (
      await post('/cases', 'alice', { title: 'Email test', description: 'Request' }).expect(201)
    ).body;
    await post(`/cases/${ticket.id}/comments`, 'agent', { body: 'private', internal: true }).expect(
      201,
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM outbox').get()?.n, 1);
    await post(`/cases/${ticket.id}/comments`, 'agent', { body: 'public', internal: false }).expect(
      201,
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM outbox').get()?.n, 2);
    await Promise.all([crm.flushEmails(), crm.flushEmails()]);
    assert.equal(deliveries, 2);
    assert.equal(failures, 2);
    const mail = db.prepare('SELECT * FROM outbox ORDER BY id').all();
    assert.ok(mail.every((m) => m.attempts === 1 && m.sentAt === null));
    await crm.flushEmails();
    assert.equal(deliveries, 2, 'backoff prevents immediate repeat');
    db.prepare("UPDATE outbox SET attempts=5,nextAttempt='1970-01-01T00:00:00.000Z'").run();
    await crm.flushEmails();
    assert.equal(deliveries, 2, 'exhausted jobs stay stopped');
  } finally {
    db.close();
    await crm.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('configured categories populate the console metadata and validate new cases', async () => {
  const crm = createTicketing({
    database: { filename: ':memory:' },
    auth: () => alice,
    categories: ['HR', 'Finance', 'Facilities'],
  });
  try {
    assert.deepEqual((await request(crm.handler).get('/api/me')).body.categories, [
      'HR',
      'Finance',
      'Facilities',
    ]);
    const post = (category: string) =>
      request(crm.handler)
        .post('/api/cases')
        .set('X-CookieCaseKit', '1')
        .send({ title: 'Desk repair', description: 'Please fix the desk', category });
    assert.equal((await post('Facilities').expect(201)).body.category, 'Facilities');
    await post('Unconfigured').expect(400);
  } finally {
    await crm.close();
  }
});
test('API-only mode does not claim the host React page or serve a standalone console', async () => {
  const crm = createTicketing({ database: { filename: ':memory:' }, auth: () => agent, ui: false });
  const app = express();
  app.use('/_casekit', crm.router);
  app.get('/support', (_req, res) => res.send('Host React page'));
  try {
    await request(app).get('/support').expect(200, 'Host React page');
    await request(app).get('/_casekit/api/me').expect(200);
    await request(app).get('/_casekit/').expect(404);
    await request(app).get('/_casekit/app.js').expect(404);
  } finally {
    await crm.close();
  }
});

test('rejects cross-origin browser writes even with the custom header', async (t) => {
  const f = fixture();
  t.after(() => f.crm.close());
  const body = { title: 'Origin test', description: 'Protected' };
  for (const origin of ['https://evil.example', 'null', 'not-a-url', 'https://support.example']) {
    await f
      .api('post', '/cases', 'alice', body)
      .set('Host', 'support.example')
      .set('Origin', origin)
      .expect(403);
  }
  await f.api('post', '/cases', 'alice', body).set('Sec-Fetch-Site', 'cross-site').expect(403);
  await f
    .api('post', '/cases', 'alice', body)
    .set('Host', 'support.example')
    .set('Origin', 'http://support.example')
    .expect(201);
  await f.create().expect(201); // Non-browser clients with no Origin remain supported.
});
