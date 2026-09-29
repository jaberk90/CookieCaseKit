import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createCloudTicketing } from '../src/cloud/core.js';
import type { CaseStore, StoredDocument } from '../src/cloud/store.js';
import type { User } from '../src/types.js';

export function memoryStore(): CaseStore {
  const data = new Map<string, StoredDocument>();
  const k = (tenant: string, key: string) => JSON.stringify([tenant, key]);
  return {
    async read(tenant, key) {
      return structuredClone(data.get(k(tenant, key)) ?? null);
    },
    async page(tenant, prefix, cursor = '', limit = 100) {
      const items = [...data]
        .filter(
          ([key, v]) => JSON.parse(key)[0] === tenant && v.key.startsWith(prefix) && v.key > cursor,
        )
        .map(([, v]) => v)
        .sort((a, b) => a.key.localeCompare(b.key));
      return structuredClone({
        items: items.slice(0, limit),
        ...(items.length > limit ? { cursor: items[limit - 1].key } : {}),
      });
    },
    async commit(tenant, checks, writes) {
      if (checks.some((c) => (data.get(k(tenant, c.key))?.revision ?? null) !== c.revision))
        return false;
      for (const w of writes) data.set(k(tenant, w.key), structuredClone(w));
      return true;
    },
  };
}
const alice: User = {
  id: 'alice',
  name: 'Alice',
  email: 'alice@example.com',
  tenantId: 'one',
  role: 'requester',
};
const staff: User = { ...alice, id: 'staff', name: 'Staff', role: 'admin' };
const users: Record<string, User> = {
  alice,
  staff,
  bob: { ...alice, id: 'bob' },
  outsider: { ...staff, tenantId: 'two' },
};
function fixture() {
  const sent: { messageId: string; subject: string; text: string; to: string }[] = [];
  const objects = new Map<string, Buffer>();
  const store = memoryStore();
  const kit = createCloudTicketing({
    store,
    auth: (req) => users[req.get('x-user') ?? ''] ?? null,
    categories: ['General', 'Contact'],
    email: {
      from: 'support@example.com',
      async send(m) {
        sent.push(m);
      },
    },
    attachments: {
      maxBytes: 100,
      storage: {
        async put(key, data) {
          objects.set(key, data);
        },
        async get(key) {
          return objects.get(key)!;
        },
        async delete(key) {
          objects.delete(key);
        },
      },
    },
  });
  const app = express();
  app.use('/kit', kit.router);
  return { kit, app, store, sent, objects };
}
const body = { title: 'Hello', description: 'Please help', category: 'Contact' };
function api(app: express.Express, method: 'get' | 'post' | 'patch', path: string, user = 'staff') {
  return request(app)
    [method]('/kit/api' + path)
    .set('x-user', user)
    .set('X-CookieCaseKit', '1');
}

test('cloud creation is atomic, retry-safe, isolated and private', async () => {
  const f = fixture();
  const cases = await Promise.all(
    Array.from({ length: 8 }, () =>
      f.kit.createCase(body, alice, { idempotencyKey: 'submission' }),
    ),
  );
  assert.equal(new Set(cases.map((c) => c.id)).size, 1);
  const c = cases[0];
  assert.equal((await api(f.app, 'get', '/cases', 'alice')).body.total, 1);
  await assert.rejects(
    f.kit.createCase({ ...body, title: 'Changed' }, alice, { idempotencyKey: 'submission' }),
    /reused/,
  );
  await api(f.app, 'get', `/cases/${c.id}`, 'bob').expect(404);
  await api(f.app, 'get', `/cases/${c.id}`, 'outsider').expect(404);
  await api(f.app, 'get', '/cases', '').expect(401);
  await api(f.app, 'post', `/cases/${c.id}/comments`, 'alice')
    .send({ body: 'Secret', internal: true })
    .expect(403);
  await f.kit.addComment(c.id, { body: 'Staff note', internal: true }, staff);
  assert.equal((await api(f.app, 'get', `/cases/${c.id}`, 'alice')).body.comments.length, 0);
  assert.equal((await api(f.app, 'get', `/cases/${c.id}`, 'staff')).body.comments.length, 1);
  const results = await Promise.all([f.kit.flushEmails('one'), f.kit.flushEmails('one')]);
  assert.equal(
    results.reduce((n, r) => n + r.sent, 0),
    1,
  );
  assert.equal(f.sent.length, 1);
});

test('cloud concurrent updates reject stale versions and block cross-origin writes', async () => {
  const f = fixture();
  const c = await f.kit.createCase(body, alice);
  const r = await Promise.allSettled([
    f.kit.updateCase(c.id, { version: 1, status: 'pending' }, staff),
    f.kit.updateCase(c.id, { version: 1, status: 'in_progress' }, staff),
  ]);
  assert.equal(r.filter((v) => v.status === 'fulfilled').length, 1);
  await api(f.app, 'post', '/cases', 'alice')
    .set('Origin', 'https://evil.example')
    .send(body)
    .expect(403);
  await api(f.app, 'patch', `/cases/${c.id}`, 'alice')
    .send({ version: 2, status: 'resolved' })
    .expect(403);
});

test('cloud email replies require matching references and deduplicate atomically', async () => {
  const f = fixture();
  const c = await f.kit.createCase(body, alice);
  await f.kit.flushEmails('one');
  const raw = `From: alice@example.com\r\nTo: support@example.com\r\nSubject: Re: [${c.number}] Case received\r\nMessage-ID: <reply@example.com>\r\nIn-Reply-To: ${f.sent[0].messageId}\r\n\r\nHere is more information.`;
  const results = await Promise.all([
    f.kit.receiveEmail('one', raw),
    f.kit.receiveEmail('one', raw),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['accepted', 'duplicate']);
  assert.equal((await f.kit.getCase(c.id, alice)).comments.length, 1);
  assert.equal((await f.kit.receiveEmail('two', raw)).status, 'ignored');
  assert.equal(
    (await f.kit.receiveEmail('one', raw.replace('From: alice', 'From: attacker'))).status,
    'ignored',
  );
});

test('cloud attachments stay quarantined, private and size limited', async () => {
  const f = fixture();
  const c = await f.kit.createCase(body, alice);
  const upload = await api(f.app, 'post', `/cases/${c.id}/attachments`)
    .set('Content-Type', 'application/octet-stream')
    .set('X-Filename', 'evidence.txt')
    .set('X-Internal', 'true')
    .send(Buffer.from('evidence'))
    .expect(201);
  const aid = upload.body.id;
  assert.equal(upload.body.key, undefined);
  await api(f.app, 'get', `/cases/${c.id}/attachments/${aid}`).expect(409);
  await f.kit.approveAttachment('one', c.id, aid, 'clean');
  await api(f.app, 'get', `/cases/${c.id}/attachments/${aid}`, 'alice').expect(404);
  const download = await api(f.app, 'get', `/cases/${c.id}/attachments/${aid}`).expect(200);
  assert.equal(download.body.toString(), 'evidence');
  assert.equal(
    (await api(f.app, 'get', `/cases/${c.id}/attachments`, 'alice')).body.items.length,
    0,
  );
  await api(f.app, 'post', `/cases/${c.id}/attachments`)
    .set('Content-Type', 'application/octet-stream')
    .set('X-Filename', 'huge.txt')
    .send(Buffer.alloc(101))
    .expect(413);
});

test('cloud rate limiting runs before authentication or database access', async () => {
  let calls = 0;
  const kit = createCloudTicketing({
    store: memoryStore(),
    auth: () => {
      calls++;
      return staff;
    },
    rateLimit: { limit: 1, windowMs: 60000 },
  });
  const app = express();
  app.use(kit.router);
  await request(app).get('/api/me').expect(200);
  await request(app).get('/api/me').expect(429);
  assert.equal(calls, 1);
});

test('explicit public origin supports proxies without trusting forwarded headers', async () => {
  const kit = createCloudTicketing({
    store: memoryStore(),
    auth: () => staff,
    publicOrigin: 'https://stocks.example',
    categories: ['Contact'],
  });
  const app = express();
  app.use(kit.router);
  await request(app)
    .post('/api/cases')
    .set('Host', 'internal.run.app')
    .set('Origin', 'https://stocks.example')
    .set('X-CookieCaseKit', '1')
    .send(body)
    .expect(201);
  for (const origin of [
    'https://evil.example',
    'https://stocks.example.evil.test',
    'null',
    'http://stocks.example',
  ]) {
    await request(app)
      .post('/api/cases')
      .set('Origin', origin)
      .set('X-Forwarded-Host', 'stocks.example')
      .set('X-CookieCaseKit', '1')
      .send(body)
      .expect(403);
  }
  await request(app)
    .post('/api/cases')
    .set('Origin', 'https://stocks.example')
    .set('Sec-Fetch-Site', 'cross-site')
    .set('X-CookieCaseKit', '1')
    .send(body)
    .expect(403);
  assert.throws(() =>
    createCloudTicketing({
      store: memoryStore(),
      auth: () => staff,
      publicOrigin: 'https://stocks.example/path',
    }),
  );
});

test('public staff replies to their own case include the full email body', async () => {
  for (const role of ['agent', 'admin'] as const) {
    const f = fixture();
    const actor = { ...alice, role };
    const c = await f.kit.createCase(body, alice);
    await f.kit.flushEmails('one');
    f.sent.length = 0;
    await f.kit.addComment(c.id, { body: 'Customer follow-up' }, alice);
    await f.kit.addComment(c.id, { body: 'Private information', internal: true }, actor);
    await f.kit.flushEmails('one');
    assert.equal(f.sent.length, 0);
    const reply = 'Thank you! Resolved.\nYour access is restored.';
    await f.kit.addComment(c.id, { body: reply }, actor);
    await f.kit.flushEmails('one');
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].to, alice.email);
    assert.match(f.sent[0].subject, /New reply/);
    assert.ok(f.sent[0].text.includes(reply));
    assert.ok(!f.sent[0].text.includes('Private information'));
  }
});
