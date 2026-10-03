import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ImapFlow } from 'imapflow';
import { cloudInbox } from '../src/cloud/inbound.js';
import { createCloudTicketing } from '../src/cloud/core.js';
import type { CaseStore, StoredDocument } from '../src/cloud/store.js';
function memoryStore(): CaseStore {
  const data = new Map<string, StoredDocument>();
  const k = (t: string, key: string) => JSON.stringify([t, key]);
  return {
    async read(t, key) {
      return structuredClone(data.get(k(t, key)) ?? null);
    },
    async page(t, prefix) {
      return {
        items: [...data]
          .filter(([key, d]) => JSON.parse(key)[0] === t && d.key.startsWith(prefix))
          .map(([, d]) => structuredClone(d)),
      };
    },
    async commit(t, checks, writes) {
      if (checks.some((c) => (data.get(k(t, c.key))?.revision ?? null) !== c.revision))
        return false;
      writes.forEach((w) => data.set(k(t, w.key), structuredClone(w)));
      return true;
    },
  };
}
const inbound = {
  connection: {
    host: 'imap.example.com',
    port: 993,
    secure: true,
    auth: { user: 'support@example.com', pass: 'test' },
  },
};
const requester = {
  id: 'customer',
  name: 'Customer',
  email: 'customer@example.com',
  tenantId: 'one',
  role: 'requester' as const,
};
async function fixture() {
  const store = memoryStore(),
    sent: { messageId: string; subject: string }[] = [];
  const kit = createCloudTicketing({
    store,
    auth: () => null,
    email: {
      from: 'support@example.com',
      send: async (m) => {
        sent.push(m);
      },
    },
  });
  const c = await kit.createCase(
    { title: 'Help', description: 'Please help', category: 'General' },
    requester,
  );
  await kit.flushEmails('one');
  const raw = Buffer.from(
    `From: customer@example.com\r\nTo: support@example.com\r\nSubject: Re: ${sent[0].subject}\r\nMessage-ID: <customer-reply@example.com>\r\nIn-Reply-To: ${sent[0].messageId}\r\n\r\nMy missing reply\r\n\r\nOn Friday someone wrote:\r\n> quoted notification`,
  );
  let validity = 1,
    failSource = false,
    connects = 0;
  const messages = new Map<number, Buffer>([
    [1, Buffer.from('Subject: unrelated\r\n\r\nHello')],
    [2, raw],
  ]);
  const makeClient = () =>
    ({
      on() {},
      async connect() {
        connects++;
      },
      mailbox: { uidValidity: validity },
      async getMailboxLock(_mailbox: string, options: unknown) {
        assert.deepEqual(options, { readOnly: true });
        return { release() {} };
      },
      async search() {
        return [...messages.keys()];
      },
      async fetchOne(uid: string, options: { size?: boolean }) {
        if (failSource && !options.size) throw Error('temporary download failure');
        const source = messages.get(Number(uid));
        return source ? (options.size ? { size: source.length } : { source }) : false;
      },
      async logout() {},
      close() {},
    }) as unknown as ImapFlow;
  return {
    store,
    kit,
    c,
    raw,
    messages,
    makeClient,
    setValidity: (v: number) => {
      validity = v;
    },
    fail: (v: boolean) => {
      failSource = v;
    },
    connects: () => connects,
  };
}
test('cloud IMAP reads seen replies, adds public conversation/history once, resumes and handles UID resets', async () => {
  const f = await fixture();
  const inbox = cloudInbox(f.store, inbound, f.kit.receiveEmail, f.makeClient);
  assert.equal((await inbox.pollInbox('one', 1)).ignored, 1);
  assert.equal((await inbox.pollInbox('one')).accepted, 1);
  const detail = await f.kit.getCase(f.c.id, { ...requester, role: 'admin' });
  assert.equal(detail.comments.length, 1);
  assert.equal(detail.comments[0].body, 'My missing reply');
  assert.equal(detail.comments[0].source, 'email');
  assert.equal(detail.comments[0].internal, false);
  assert.ok(detail.events.some((e) => e.action === 'Email reply added'));
  const restarted = cloudInbox(f.store, inbound, f.kit.receiveEmail, f.makeClient);
  assert.equal((await restarted.pollInbox('one')).processed, 0);
  f.setValidity(2);
  assert.equal((await restarted.pollInbox('one')).duplicate, 1);
  assert.equal((await f.kit.getCase(f.c.id, requester)).comments.length, 1);
  assert.equal((await restarted.pollInbox('other')).accepted, 0);
  await inbox.close();
  await restarted.close();
  await f.kit.close();
});
test('download/storage failures retain the cursor and concurrent polling stays duplicate-safe', async () => {
  const f = await fixture();
  f.messages.delete(1);
  const inbox = cloudInbox(f.store, inbound, f.kit.receiveEmail, f.makeClient);
  f.fail(true);
  await assert.rejects(inbox.pollInbox('one'), /temporary/);
  f.fail(false);
  const other = cloudInbox(f.store, inbound, f.kit.receiveEmail, f.makeClient);
  await Promise.all([inbox.pollInbox('one'), inbox.pollInbox('one'), other.pollInbox('one')]);
  assert.equal((await f.kit.getCase(f.c.id, requester)).comments.length, 1);
  assert.equal((await inbox.pollInbox('one')).processed, 0);
  await inbox.close();
  await assert.rejects(inbox.pollInbox('one'), /closed/);
  await other.close();
});
test('cloud IMAP skips oversized/forged mail and refuses insecure connections', async () => {
  const f = await fixture();
  f.messages.set(1, Buffer.alloc(1024 * 1024 + 1));
  f.messages.set(2, Buffer.from(f.raw.toString().replace('From: customer', 'From: attacker')));
  const inbox = cloudInbox(f.store, inbound, f.kit.receiveEmail, f.makeClient);
  const result = await inbox.pollInbox('one');
  assert.equal(result.ignored, 2);
  assert.equal(result.reasons.message_too_large, 1);
  assert.equal((await f.kit.getCase(f.c.id, requester)).comments.length, 0);
  assert.throws(
    () =>
      cloudInbox(
        f.store,
        { connection: { ...inbound.connection, secure: false } },
        f.kit.receiveEmail,
        f.makeClient,
      ),
    /TLS/,
  );
  assert.throws(
    () =>
      cloudInbox(
        f.store,
        { connection: { ...inbound.connection, tls: { rejectUnauthorized: false } } },
        f.kit.receiveEmail,
        f.makeClient,
      ),
    /TLS/,
  );
  await assert.rejects(inbox.pollInbox('one', 101), /limit/);
  await inbox.close();
});
test('confirmed case email history can backfill an idempotent sink without sending again', async () => {
  const f = await fixture();
  let attempts = 0;
  const receipts: unknown[] = [];
  await assert.rejects(
    f.kit.syncSentEmails('one', async () => {
      attempts++;
      throw Error('sink down');
    }),
    /sink down/,
  );
  const sink = async (m: unknown) => {
    attempts++;
    receipts.push(m);
  };
  assert.equal((await f.kit.syncSentEmails('one', sink)).synced, 1);
  assert.equal((await f.kit.syncSentEmails('one', sink)).synced, 0);
  assert.equal(attempts, 2);
  assert.equal(receipts.length, 1);
  assert.equal((await f.kit.flushEmails('one')).sent, 0);
});

test('a cursor write failure replays the accepted message without duplicating the note', async () => {
  const f = await fixture();
  f.messages.delete(1);
  const commit = f.store.commit;
  let fail = true;
  f.store.commit = async (t, checks, writes) => {
    if (fail && writes.some((w) => w.key.startsWith('inbox-'))) {
      fail = false;
      throw Error('cursor unavailable');
    }
    return commit(t, checks, writes);
  };
  const inbox = cloudInbox(f.store, inbound, f.kit.receiveEmail, f.makeClient);
  await assert.rejects(inbox.pollInbox('one'), /cursor unavailable/);
  assert.equal((await inbox.pollInbox('one')).duplicate, 1);
  assert.equal((await f.kit.getCase(f.c.id, requester)).comments.length, 1);
  await inbox.close();
});
