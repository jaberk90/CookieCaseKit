# Operations

## Hosting

Use Node 22.13+ (Node 24 recommended) and persistent local disk. Run one CookieCaseKit instance per SQLite file. WAL mode and a five-second busy timeout are enabled. SQLite calls are synchronous: this package is intended for modest service-desk workloads, not high-throughput distributed operation.

The package auto-creates schema version 2 and migrates version 1 in a transaction, preserving existing cases and backfilling case links on queued notifications. Future incompatible migrations must be implemented and tested before upgrading; back up before every package upgrade. The current implementation rejects unknown schema versions. Do not manually edit case or history records.

Put TLS, request rate limiting, request logging, session expiry, and your identity provider in the host or reverse proxy. Map stable IDs and support roles from verified server-side identities. Never derive tenant IDs or staff roles directly from unverified request headers/body. Keep credentialed CORS restricted. Protect the entire mount with the authentication callback, including UI assets.

Call `server.close()` to drain requests, then await `ticketing.close()`. Do not share a file between clustered workers: notification delivery has an in-process lock and is designed for one worker. SMTP outages do not roll back case creation; the durable queue retries separately.

## Backups

Stop the service and await `close()`, then copy the database file to protected backup storage. For online backups use SQLite's backup API/tooling, not a live file copy that ignores WAL state. Test restoration to another path and restart the package against that restored file. Backups and SMTP delivery contain user email addresses and case content; apply your organization's access and retention policies.

## Notification queue

The `outbox` table contains `recipient`, `subject`, `body`, `attempts`, `nextAttempt`, and `sentAt`. No SMTP credentials are stored in it. Unsent rows with `attempts < 5` are processed in batches of 25. Retry delays are `60 seconds × 2^attempts`. After five failures, rows remain available for operator investigation. Logs report transport errors; use a redacting logger appropriate to your SMTP provider.

With the service stopped or through trusted admin database tooling, inspect failed mail:

```sql
SELECT id, attempts, nextAttempt FROM outbox
WHERE sentAt IS NULL AND attempts >= 5;
```

After fixing SMTP settings, requeue a reviewed row using a bound ID:

```sql
UPDATE outbox SET attempts = 0, nextAttempt = '1970-01-01T00:00:00.000Z'
WHERE id = ? AND sentAt IS NULL;
```

There is no automatic outbox retention purge. Define a retention policy through your operational tooling. Keep sent rows with `messageId` for cases that must still accept email replies: removing those rows also removes the matching thread reference. Re-delivery is possible after a crash between SMTP acceptance and marking a row sent. Internal notes are never enqueued.

## Limits

No file attachments, escalation scheduler, custom workflow builder, host-directory user search, full-text index, or database adapter layer is included in v0.1.0. Resolution deadlines are elapsed wall-clock hours and only surfaced as overdue counts; the package does not send automated escalation emails. Case deletion is intentionally absent to preserve history; data retention/erasure needs a separately reviewed host policy.

## Incoming replies

Configure `email.replyTo` to point to a dedicated mailbox and set `email.inbound.connection` with IMAP credentials. Port 993 with `secure: true` is recommended; a non-implicit-TLS connection must set `doSTARTTLS: true`. Environment examples are in `.env.example`. The host must load these values; they are not auto-loaded by the library.

The worker fetches at most 25 messages per interval without marking them read, moving them or deleting them. It records progress in `inbox_cursors` keyed by host, port, user, mailbox and UID validity. Connection/fetch failures leave the failing UID available for retry. A mailbox UID validity change causes a rescan; `inbound_messages` deduplicates messages already imported. Keep that table when backing up or retaining case data.

Ignored messages are logged by UID and reason, without logging the email body, and advance the mailbox cursor. Review the original message in the mailbox if needed; after correcting a recoverable issue you can explicitly pass its raw RFC822 source to `receiveEmail()`. Do not reset the cursor casually or expose that method through an unauthenticated HTTP route. The package does not acknowledge incoming replies by email, avoiding auto-responder loops.

Matching requires exactly one case ID in the subject, the requester's From address, and a reference to a stored random notification Message-ID. Mail clients must preserve the normal reply threading headers. Fresh messages containing only a case ID are not accepted. Thread IDs from pre-upgrade sent notifications are unavailable; ask the requester to reply to a new notification. SMTP providers must preserve the Message-ID set by the package.

SMTP/IMAP credentials are configuration only. The database stores threading IDs and public reply notes. Inbound attachments are ignored, full MIME messages are bounded to 1 MiB, and note text is bounded to 10,000 characters. Standard quote stripping is best-effort; complex inline replies or unusual client quoting may need review. Inbound mail does not change resolved/closed statuses automatically.
