import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
import { createTicketing } from '../src/index.js';
import { openDatabase } from '../src/database.js';
import type { User } from '../src/types.js';

const alice: User = {
  id: 'alice',
  name: 'Alice',
  email: 'alice@example.com',
  role: 'requester',
  tenantId: 'acme',
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cookiecasekit-email-'));
  const filename = join(directory, 'cases.sqlite');
  const sent: Record<string, unknown>[] = [];
  const kit = createTicketing({
    database: { filename },
    auth: () => alice,
    email: {
      from: 'cases@example.com',
      replyTo: 'replies@example.com',
      transport: {
        name: 'capture',
        version: '1',
        send: (
          mail: { data: Record<string, unknown> },
          done: (error: null, result: object) => void,
        ) => {
          sent.push(mail.data);
          done(null, { messageId: mail.data.messageId });
        },
      } as never,
    },
  });
  const ticket = (
    await request(kit.handler)
      .post('/api/cases')
      .set('X-CookieCaseKit', '1')
      .send({ title: 'Account access', description: 'Please help' })
      .expect(201)
  ).body;
  await kit.flushEmails();
  const reference = String(sent[0].messageId);
  const raw = (overrides: Record<string, string> = {}) => {
    const fields = {
      from: alice.email,
      id: '<reply-1@example.com>',
      subject: `Re: [${ticket.number}] Case received`,
      reference,
      extra: '',
      body: 'I can sign in now, thank you!\r\n\r\nOn Monday, Support wrote:\r\n> Original notification',
      ...overrides,
    };
    return `From: ${fields.from}\r\nTo: replies@example.com\r\nMessage-ID: ${fields.id}\r\nSubject: ${fields.subject}\r\nIn-Reply-To: ${fields.reference}\r\nReferences: ${fields.reference}\r\n${fields.extra}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${fields.body}`;
  };
  return {
    kit,
    ticket,
    sent,
    reference,
    raw,
    filename,
    async cleanup() {
      await kit.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test('case creation sends a threaded notification and replying adds one public email note', async () => {
  const f = await fixture();
  try {
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].to, alice.email);
    assert.equal(f.sent[0].replyTo, 'replies@example.com');
    assert.match(String(f.sent[0].subject), new RegExp(f.ticket.number));
    assert.match(f.reference, /^<[\w-]+@example.com>$/);
    const result = await f.kit.receiveEmail(f.raw());
    assert.equal(result.status, 'accepted');
    const detail = (await request(f.kit.handler).get(`/api/cases/${f.ticket.id}`)).body;
    assert.equal(detail.comments.length, 1);
    assert.equal(detail.comments[0].body, 'I can sign in now, thank you!');
    assert.equal(detail.comments[0].internal, false);
    assert.equal(detail.comments[0].source, 'email');
    assert.equal(detail.comments[0].authorId, alice.id);
    assert.equal(detail.version, 2);
    assert.equal((await f.kit.receiveEmail(f.raw())).status, 'duplicate');
    assert.equal(
      (await request(f.kit.handler).get(`/api/cases/${f.ticket.id}`)).body.comments.length,
      1,
    );
    await f.kit.flushEmails();
    assert.equal(f.sent.length, 1, 'inbound messages must not cause email loops');
    const db = new DatabaseSync(f.filename);
    try {
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM events WHERE action='Email reply added'").get()?.n,
        1,
      );
    } finally {
      db.close();
    }
  } finally {
    await f.cleanup();
  }
});
test('email ingestion rejects forged, ambiguous, automated, empty and oversized replies', async () => {
  const f = await fixture();
  try {
    for (const change of [
      { from: 'attacker@example.com' },
      { reference: '<guessed@example.com>' },
      { subject: 'Re: [CS-99999] Case received' },
      { subject: `Re: [${f.ticket.number}] [CS-99999]` },
      { extra: 'Auto-Submitted: auto-replied\r\n' },
      { extra: 'List-Id: customers.example.com\r\n' },
      { id: '' },
      { body: '> quoted text only' },
      { body: 'x'.repeat(10001) },
    ] as Record<string, string>[])
      assert.equal(
        (await f.kit.receiveEmail(f.raw(change))).status,
        'ignored',
        JSON.stringify(change).slice(0, 100),
      );
    assert.deepEqual(await f.kit.receiveEmail('x'.repeat(1024 * 1024 + 1)), {
      status: 'ignored',
      reason: 'message_too_large',
    });
    assert.equal(
      (await request(f.kit.handler).get(`/api/cases/${f.ticket.id}`)).body.comments.length,
      0,
    );
  } finally {
    await f.cleanup();
  }
});
test('references survive replies, case-insensitive sender matching, HTML mail and concurrent duplicate deliveries', async () => {
  const f = await fixture();
  try {
    const source = f
      .raw({ from: 'Alice <ALICE@example.com>', body: '<p>Still need help &amp; guidance.</p>' })
      .replace('Content-Type: text/plain', 'Content-Type: text/html')
      .replace(
        `In-Reply-To: ${f.reference}`,
        'In-Reply-To: <previous-requester-reply@example.com>',
      );
    const results = await Promise.all([f.kit.receiveEmail(source), f.kit.receiveEmail(source)]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['accepted', 'duplicate']);
    const detail = (await request(f.kit.handler).get(`/api/cases/${f.ticket.id}`)).body;
    assert.equal(detail.comments[0].body, 'Still need help & guidance.');
  } finally {
    await f.cleanup();
  }
});
test('thread correlation cannot post into a different tenant or reuse a message ID on another case', async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.filename);
  try {
    const other = (
      await request(f.kit.handler)
        .post('/api/cases')
        .set('X-CookieCaseKit', '1')
        .send({ title: 'Other case', description: 'Another request' })
    ).body;
    db.prepare('UPDATE cases SET tenantId=? WHERE id=?').run('another-tenant', other.id);
    const wrong = await f.kit.receiveEmail(
      f.raw({ subject: `Re: [${other.number}] Case received` }),
    );
    assert.equal(wrong.status, 'ignored');
    await f.kit.receiveEmail(f.raw());
    const otherReference = String(
      db.prepare('SELECT messageId FROM outbox WHERE caseId=?').get(other.id)?.messageId,
    );
    const reused = await f.kit.receiveEmail(
      f.raw({ subject: `Re: [${other.number}] Case received`, reference: otherReference }),
    );
    assert.deepEqual(reused, { status: 'ignored', reason: 'message_id_conflict' });
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM comments WHERE caseId=?').get(other.id)?.n,
      0,
    );
  } finally {
    db.close();
    await f.cleanup();
  }
});
test('migration preserves v1 cases and queued mail, is idempotent, and refuses future schemas', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cookiecasekit-migration-'));
  const filename = join(dir, 'old.sqlite');
  let db = openDatabase(filename);
  // Reconstruct the previous schema around a real record to exercise upgrade backfill.
  db.exec(
    "INSERT INTO cases (number,tenantId,title,description,priority,category,requesterId,requesterName,requesterEmail,createdAt,updatedAt,dueAt) VALUES ('CS-00001','acme','Saved case','Description','normal','General','alice','Alice','alice@example.com','2026-01-01','2026-01-01','2026-01-04'); INSERT INTO outbox (recipient,subject,body,nextAttempt) VALUES ('alice@example.com','[CS-00001] Case received','Hello','2026-01-01');",
  );
  db.exec(
    'DROP TABLE inbound_messages; DROP TABLE inbox_cursors; DROP INDEX outbox_message_id; ALTER TABLE outbox DROP COLUMN messageId; ALTER TABLE outbox DROP COLUMN caseId; ALTER TABLE comments DROP COLUMN source; DELETE FROM schema_version WHERE version=2;',
  );
  db.close();
  try {
    db = openDatabase(filename);
    assert.equal(db.prepare('SELECT title FROM cases').get()?.title, 'Saved case');
    assert.equal(db.prepare('SELECT caseId FROM outbox').get()?.caseId, 1);
    assert.equal(db.prepare('SELECT MAX(version) AS n FROM schema_version').get()?.n, 2);
    db.close();
    db = openDatabase(filename);
    assert.equal(db.prepare('SELECT count(*) AS n FROM cases').get()?.n, 1);
    db.exec('INSERT INTO schema_version VALUES (99)');
    db.close();
    assert.throws(() => openDatabase(filename), /Unsupported database schema/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('IMAP polling uses durable UID cursors, deduplicates replays, and retries failed fetches', async () => {
  const { createInbound } = await import('../src/inbound.js');
  const f = await fixture();
  const db = new DatabaseSync(f.filename);
  let fail = true;
  let releases = 0;
  const fetched: number[] = [];
  const fake = {
    mailbox: { uidValidity: 123n },
    on() {},
    async connect() {},
    async logout() {},
    close() {},
    async getMailboxLock() {
      return {
        release() {
          releases++;
        },
      };
    },
    async search() {
      return [1, 2, 3];
    },
    async fetchOne(id: string, query: { size?: boolean }) {
      const uid = Number(id);
      if (query.size) return { size: 500 };
      fetched.push(uid);
      if (uid === 3 && fail) throw new Error('temporary connection failure');
      return {
        source: Buffer.from(
          f.raw({ id: uid === 3 ? '<another-reply@example.com>' : '<same-reply@example.com>' }),
        ),
      };
    },
  };
  const config = {
    connection: {
      host: 'imap.example.com',
      port: 993,
      secure: true,
      auth: { user: 'mailbox', pass: 'test' },
    },
    pollIntervalMs: 60000,
  };
  const inbox = createInbound(
    db,
    config,
    { error() {} },
    () => fake as unknown as import('imapflow').ImapFlow,
  );
  try {
    await assert.rejects(inbox.pollInbox(), /temporary connection failure/);
    assert.equal(db.prepare('SELECT lastUid FROM inbox_cursors').get()?.lastUid, 2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM comments').get()?.n, 1);
    fail = false;
    await inbox.pollInbox();
    assert.deepEqual(fetched, [1, 2, 3, 3]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM comments').get()?.n, 2);
    assert.equal(db.prepare('SELECT lastUid FROM inbox_cursors').get()?.lastUid, 3);
    await inbox.pollInbox();
    assert.deepEqual(fetched, [1, 2, 3, 3]);
    fake.mailbox.uidValidity = 124n;
    await inbox.pollInbox();
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM comments').get()?.n,
      2,
      'UID validity reset must not duplicate messages',
    );
    assert.equal(releases, 4);
  } finally {
    await inbox.close();
    db.close();
    await f.cleanup();
  }
});
