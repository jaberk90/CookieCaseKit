import { createHash } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import type { InboundEmailConfig } from '../types.js';
import { atomic, type CaseStore } from './store.js';

const MAX_BYTES = 1024 * 1024;
export type CloudInboundConfig = Pick<InboundEmailConfig, 'connection' | 'mailbox'>;
export interface InboxResult {
  processed: number;
  accepted: number;
  duplicate: number;
  ignored: number;
  reasons: Record<string, number>;
}

/** Durable UID cursors; deliberately never changes Seen flags or deletes mailbox messages. */
export function cloudInbox(
  store: CaseStore,
  config: CloudInboundConfig | undefined,
  receive: (tenant: string, source: Buffer) => Promise<{ status: string; reason?: string }>,
  makeClient = (options: ConstructorParameters<typeof ImapFlow>[0]) => new ImapFlow(options),
) {
  if (config) {
    const c = config.connection;
    if (!c?.host || !c.auth?.user || (!c.auth.pass && !c.auth.accessToken))
      throw new Error('IMAP host and authentication are required');
    if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535)
      throw new Error('Invalid IMAP port');
    if ((c.secure !== true && c.doSTARTTLS !== true) || c.tls?.rejectUnauthorized === false)
      throw new Error('IMAP requires verified TLS or mandatory STARTTLS');
  }
  let closed = false;
  const running = new Map<string, Promise<InboxResult>>();
  async function poll(tenant: string, limit: number): Promise<InboxResult> {
    const result: InboxResult = {
      processed: 0,
      accepted: 0,
      duplicate: 0,
      ignored: 0,
      reasons: {},
    };
    if (!config) return result;
    const client = makeClient({
      ...config.connection,
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });
    let connectionError: Error | undefined;
    client.on('error', (error: Error) => {
      connectionError = error;
    });
    try {
      await client.connect();
      const mailbox = config.mailbox ?? 'INBOX';
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        if (!client.mailbox) throw new Error('IMAP mailbox unavailable');
        const key =
          'inbox-' +
          createHash('sha256')
            .update(
              JSON.stringify([
                config.connection.host,
                config.connection.port,
                config.connection.auth?.user,
                mailbox,
                String(client.mailbox.uidValidity),
              ]),
            )
            .digest('hex');
        const cursor = Number((await store.read(tenant, key))?.value.lastUid ?? 0);
        const found = await client.search({ uid: `${cursor + 1}:*` }, { uid: true });
        for (const uid of (found || [])
          .filter((uid) => uid > cursor)
          .sort((a, b) => a - b)
          .slice(0, limit)) {
          if (closed) break;
          if (connectionError) throw connectionError;
          const metadata = await client.fetchOne(String(uid), { size: true }, { uid: true });
          let outcome: { status: string; reason?: string };
          if (!metadata) outcome = { status: 'ignored', reason: 'message_removed' };
          else {
            if (typeof metadata.size !== 'number') throw new Error('IMAP message size missing');
            if (metadata.size > MAX_BYTES)
              outcome = { status: 'ignored', reason: 'message_too_large' };
            else {
              const mail = await client.fetchOne(
                String(uid),
                { source: { start: 0, maxLength: MAX_BYTES + 1 } },
                { uid: true },
              );
              if (!mail || !mail.source)
                throw new Error('IMAP message source missing; retry next poll');
              outcome = await receive(tenant, mail.source);
            }
          }
          if (connectionError) throw connectionError;
          // Persist only after ingestion. Atomic Message-ID deduplication makes crash replay safe.
          await atomic(store, tenant, async (tx) => {
            const old = await tx.get(key);
            tx.put(key, { lastUid: Math.max(uid, Number(old?.lastUid ?? 0)) });
          });
          result.processed++;
          if (outcome.status === 'accepted') result.accepted++;
          else if (outcome.status === 'duplicate') result.duplicate++;
          else {
            result.ignored++;
            const reason = outcome.reason ?? 'unknown';
            result.reasons[reason] = (result.reasons[reason] ?? 0) + 1;
          }
        }
      } finally {
        lock.release();
      }
      await client.logout();
      return result;
    } finally {
      client.close();
    }
  }
  return {
    pollInbox(tenant: string, limit = 25): Promise<InboxResult> {
      if (closed) return Promise.reject(new Error('CookieCaseKit is closed'));
      if (!tenant || tenant.length > 200) return Promise.reject(new Error('Invalid tenant'));
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return Promise.reject(new Error('Inbox limit must be between 1 and 100'));
      if (!running.has(tenant)) {
        const work = poll(tenant, limit).finally(() => {
          running.delete(tenant);
        });
        running.set(tenant, work);
      }
      return running.get(tenant)!;
    },
    async close() {
      closed = true;
      await Promise.allSettled(running.values());
    },
  };
}
