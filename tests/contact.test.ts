import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createContactWebsite } from '../examples/contact-us.js';
import { createTicketing, TicketingError } from '../src/index.js';

function fixture() {
  return createContactWebsite({
    database: { filename: ':memory:' },
    tenantId: 'my-website',
    // Headers simulate an existing verified session ONLY in tests, never in the integration.
    getCurrentUser: (req) =>
      req.get('x-test-user')
        ? {
            id: req.get('x-test-user')!,
            displayName: 'Jordan Admin',
            email: 'admin@example.com',
            permissions: req.get('x-test-user') === 'admin' ? ['support:access'] : [],
          }
        : null,
    protectContact: (req, res, next) => {
      if (req.get('x-test-blocked')) {
        res.status(429).json({ error: 'Too many requests' });
        return;
      }
      next();
    },
  });
}

test('anonymous contact submissions create cases without giving access to the console or case API', async () => {
  const { app, support } = fixture();
  try {
    const response = await request(app)
      .post('/api/contact')
      .send({
        name: 'Taylor Visitor',
        email: 'visitor@example.com',
        subject: 'Pricing question',
        message: 'Please explain the plans.',
        tenantId: 'attacker',
        role: 'admin',
        category: 'Billing',
        priority: 'urgent',
      })
      .expect(201);
    assert.deepEqual(Object.keys(response.body).sort(), ['message', 'reference']);
    assert.equal(response.body.reference, 'CS-00001');
    for (const path of [
      '/support/',
      '/support/app.js',
      '/support/api/me',
      '/support/api/cases',
      '/support/api/cases/1',
    ]) {
      await request(app).get(path).expect(401);
      await request(app).get(path).set('x-test-user', 'member').expect(401);
    }
    await request(app)
      .post('/support/api/cases')
      .set('X-CookieCaseKit', '1')
      .send({ title: 'Bypass', description: 'Bypass' })
      .expect(401);
    const details = (
      await request(app).get('/support/api/cases/1').set('x-test-user', 'admin').expect(200)
    ).body;
    assert.equal(details.tenantId, 'my-website');
    assert.equal(details.requesterName, 'Taylor Visitor');
    assert.equal(details.category, 'Contact');
    assert.equal(details.priority, 'normal');
    assert.equal(details.requesterEmail, 'visitor@example.com');
    assert.match(details.requesterId, /^contact:/);
    const me = (await request(app).get('/support/api/me').set('x-test-user', 'admin').expect(200))
      .body.user;
    assert.equal(me.name, 'Jordan Admin');
    assert.equal(me.role, 'admin');
    await request(app)
      .post('/support/api/cases/1/comments')
      .set('x-test-user', 'admin')
      .set('X-CookieCaseKit', '1')
      .send({ body: 'I can help with pricing.' })
      .expect(201);
    assert.equal(
      (await request(app).get('/support/api/cases/1').set('x-test-user', 'admin')).body.comments[0]
        .authorName,
      'Jordan Admin',
    );
  } finally {
    await support.close();
  }
});

test('contact submissions are validated and pass through the host form protection', async () => {
  const { app, support } = fixture();
  const valid = {
    name: 'Taylor',
    email: 'visitor@example.com',
    subject: 'Hello',
    message: 'Help please',
  };
  try {
    await request(app)
      .post('/api/contact')
      .send({ ...valid, name: '' })
      .expect(400);
    await request(app)
      .post('/api/contact')
      .send({ ...valid, email: 'invalid' })
      .expect(400);
    await request(app)
      .post('/api/contact')
      .send({ ...valid, message: '' })
      .expect(400);
    await request(app).post('/api/contact').set('x-test-blocked', '1').send(valid).expect(429);
    await request(app).post('/api/contact').type('form').send(valid).expect(415);
    assert.equal(
      (await request(app).get('/support/api/cases').set('x-test-user', 'admin')).body.total,
      0,
    );
  } finally {
    await support.close();
  }
});

test('server-side creation queues requester email and validates independently of HTTP auth', async () => {
  const messages: Record<string, unknown>[] = [];
  const support = createTicketing({
    database: { filename: ':memory:' },
    auth: () => null,
    email: {
      from: 'help@example.com',
      transport: {
        name: 'capture',
        version: '1',
        send: (
          mail: { data: Record<string, unknown> },
          done: (error: null, result: object) => void,
        ) => {
          messages.push(mail.data);
          done(null, {});
        },
      } as never,
    },
  });
  try {
    const ticket = support.createCase(
      { title: 'Contact request', description: 'Hello' },
      { id: 'contact:123', name: 'Visitor', email: 'visitor@example.com', tenantId: 'website' },
    );
    await support.flushEmails();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].to, 'visitor@example.com');
    assert.match(String(messages[0].subject), new RegExp(ticket.number));
    assert.ok(!String(messages[0].text).includes('/support'));
    assert.throws(
      () =>
        support.createCase(
          { title: '', description: 'Hello' },
          { id: 'contact:123', name: 'Visitor', email: 'visitor@example.com', tenantId: 'website' },
        ),
      TicketingError,
    );
  } finally {
    await support.close();
  }
  assert.throws(
    () =>
      support.createCase(
        { title: 'Hello', description: 'Hello' },
        { id: 'x', name: 'X', email: 'x@example.com', tenantId: 'website' },
      ),
    /closed/,
  );
});
