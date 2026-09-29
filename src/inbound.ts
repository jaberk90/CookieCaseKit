import { ImapFlow } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './database.js';
import type { Case, Config, InboundEmailConfig, InboundEmailResult } from './types.js';

const MAX_MESSAGE_BYTES = 1024 * 1024;
const messageIdPattern = /^<[^<>\s]{1,990}>$/;
function replyText(value: string) {
  const lines = value.replaceAll('\r\n', '\n').split('\n');
  const result: string[] = [];
  for (const line of lines) {
    if (
      /^\s*(?:On .+wrote:|[-_]{2,}\s*Original Message\s*[-_]*|--- CookieCaseKit reply ---)/i.test(
        line,
      )
    )
      break;
    if (!/^\s*>/.test(line)) result.push(line);
  }
  return result.join('\n').trim();
}

/** Mailbox access is server-side only. No unauthenticated HTTP ingestion route is exposed. */
export function createInbound(
  db: DatabaseSync,
  config: InboundEmailConfig | undefined,
  logger: NonNullable<Config['logger']>,
  makeClient: (options: ConstructorParameters<typeof ImapFlow>[0]) => ImapFlow = (options) =>
    new ImapFlow(options),
  backgroundWorkers = true,
) {
  let stopped = false;
  let polling: Promise<void> | undefined;
  const inflight = new Set<Promise<InboundEmailResult>>();
  async function ingest(source: string | Buffer): Promise<InboundEmailResult> {
    const ignore = (reason: string): InboundEmailResult => ({ status: 'ignored', reason });
    if (Buffer.byteLength(source) > MAX_MESSAGE_BYTES) return ignore('message_too_large');
    let mail: ParsedMail;
    try {
      mail = await simpleParser(source, {
        skipHtmlToText: false,
        skipTextToHtml: true,
        skipImageLinks: true,
        maxHtmlLengthToParse: MAX_MESSAGE_BYTES,
      });
    } catch {
      return ignore('malformed_message');
    }
    const messageId = mail.messageId;
    if (!messageId || !messageIdPattern.test(messageId))
      return ignore('missing_or_invalid_message_id');
    const autoSubmitted = mail.headers.get('auto-submitted');
    if (
      (autoSubmitted && String(autoSubmitted).toLowerCase() !== 'no') ||
      /^(bulk|list|junk)$/i.test(String(mail.headers.get('precedence') ?? '')) ||
      mail.headerLines.some((header) => header.key === 'list-id')
    )
      return ignore('automated_message');
    const senders = mail.from?.value ?? [];
    if (senders.length !== 1 || !senders[0].address) return ignore('invalid_sender');
    const sender = senders[0].address.toLowerCase();
    const ids = [...new Set(mail.subject?.toUpperCase().match(/\bCS-\d+\b/g) ?? [])];
    if (ids.length !== 1) return ignore('missing_or_ambiguous_case_id');
    const references = [
      ...new Set(
        [
          mail.inReplyTo,
          ...(Array.isArray(mail.references) ? mail.references : [mail.references]),
        ].filter((v): v is string => typeof v === 'string' && messageIdPattern.test(v)),
      ),
    ];
    if (!references.length || references.length > 100)
      return ignore('missing_or_invalid_thread_reference');
    // Case number and From alone are guessable. Match a random notification Message-ID as well.
    const placeholders = references.map(() => '?').join(',');
    const matches = db
      .prepare(
        `SELECT DISTINCT c.* FROM cases c JOIN outbox o ON o.caseId = c.id WHERE o.messageId IN (${placeholders}) AND lower(o.recipient) = ? AND lower(c.requesterEmail) = ? AND c.number = ?`,
      )
      .all(...references, sender, sender, ids[0]);
    if (matches.length !== 1) return ignore('unrecognized_thread_or_sender');
    const ticket = matches[0] as unknown as Case;
    const existing = db
      .prepare('SELECT caseId, commentId FROM inbound_messages WHERE messageId = ?')
      .get(messageId);
    if (existing) {
      if (existing.caseId !== ticket.id) return ignore('message_id_conflict');
      return { status: 'duplicate', caseId: ticket.id, commentId: Number(existing.commentId) };
    }
    const body = replyText(mail.text ?? '');
    if (!body) return ignore('empty_reply');
    if (body.length > 10000) return ignore('reply_too_long');
    return transaction(db, () => {
      const now = new Date().toISOString();
      const result = db
        .prepare(
          "INSERT INTO comments (caseId,authorId,authorName,body,internal,createdAt,source) VALUES (?,?,?,?,0,?,'email')",
        )
        .run(ticket.id, ticket.requesterId, ticket.requesterName, body, now);
      const commentId = Number(result.lastInsertRowid);
      db.prepare(
        'INSERT INTO inbound_messages (messageId,caseId,commentId,receivedAt) VALUES (?,?,?,?)',
      ).run(messageId, ticket.id, commentId, now);
      db.prepare('UPDATE cases SET updatedAt=?,version=version+1 WHERE id=?').run(now, ticket.id);
      db.prepare('INSERT INTO events (caseId,actorName,action,createdAt) VALUES (?,?,?,?)').run(
        ticket.id,
        ticket.requesterName,
        'Email reply added',
        now,
      );
      // Do not auto-reply: avoids mail loops and never turns a requester message into an internal note.
      return { status: 'accepted', caseId: ticket.id, commentId };
    });
  }
  function receiveEmail(source: string | Buffer): Promise<InboundEmailResult> {
    if (stopped) return Promise.reject(new Error('CookieCaseKit is closed'));
    const work = ingest(source);
    inflight.add(work);
    void work.then(
      () => inflight.delete(work),
      () => inflight.delete(work),
    );
    return work;
  }
  async function poll() {
    if (!config) return;
    const client = makeClient({
      ...config.connection,
      logger: false,
      disableAutoIdle: true,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });
    // ImapFlow may emit an error independently of a rejected command.
    client.on('error', (error) => logger.error('CookieCaseKit IMAP connection failed', error));
    try {
      await client.connect();
      const mailbox = config.mailbox ?? 'INBOX';
      const lock = await client.getMailboxLock(mailbox);
      try {
        if (!client.mailbox) return;
        const key = JSON.stringify([
          config.connection.host,
          config.connection.port,
          config.connection.auth?.user,
          mailbox,
        ]);
        const validity = String(client.mailbox.uidValidity);
        const cursor = Number(
          db
            .prepare('SELECT lastUid FROM inbox_cursors WHERE mailboxKey=? AND uidValidity=?')
            .get(key, validity)?.lastUid ?? 0,
        );
        const uids = await client.search({ uid: `${cursor + 1}:*` }, { uid: true });
        if (!uids) return;
        for (const uid of uids
          .filter((uid) => uid > cursor)
          .sort((a, b) => a - b)
          .slice(0, 25)) {
          if (stopped) break;
          const metadata = await client.fetchOne(String(uid), { size: true }, { uid: true });
          if (metadata && typeof metadata.size !== 'number')
            throw new Error('IMAP message size missing');
          if (metadata && metadata.size! <= MAX_MESSAGE_BYTES) {
            const message = await client.fetchOne(
              String(uid),
              { source: { start: 0, maxLength: MAX_MESSAGE_BYTES + 1 } },
              { uid: true },
            );
            if (message && !message.source) throw new Error('IMAP message source missing');
            if (message && message.source) {
              const result = await receiveEmail(message.source);
              if (result.status === 'ignored')
                logger.error(`CookieCaseKit skipped inbox UID ${uid}: ${result.reason}`);
            }
          } else if (metadata)
            logger.error(`CookieCaseKit skipped inbox UID ${uid}: message_too_large`);
          // Advance only after processing; replay after a crash is safe due to message-id deduplication.
          db.prepare(
            'INSERT INTO inbox_cursors (mailboxKey,uidValidity,lastUid) VALUES (?,?,?) ON CONFLICT(mailboxKey,uidValidity) DO UPDATE SET lastUid=excluded.lastUid',
          ).run(key, validity, uid);
        }
      } finally {
        lock.release();
      }
      await client.logout();
    } finally {
      client.close();
    }
  }
  function pollInbox(): Promise<void> {
    if (stopped || !config) return Promise.resolve();
    if (!polling)
      polling = poll().finally(() => {
        polling = undefined;
      });
    return polling;
  }
  const timer =
    config && backgroundWorkers
      ? setInterval(() => {
          void pollInbox().catch((error) =>
            logger.error('CookieCaseKit inbox polling failed', error),
          );
        }, config.pollIntervalMs ?? 30000)
      : undefined;
  timer?.unref();
  return {
    receiveEmail,
    pollInbox,
    async close() {
      stopped = true;
      if (timer) clearInterval(timer);
      await Promise.allSettled([...(polling ? [polling] : []), ...inflight]);
    },
  };
}
