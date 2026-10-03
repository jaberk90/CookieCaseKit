# CookieCaseKit 1.2.0

Fix cloud email reply ingestion with a scheduler-driven IMAP worker. Previously the cloud integration could send case notifications but had no mailbox poller, so replies never reached `receiveEmail`.

- Add `email.inbound` configuration and `pollInbox(tenant, limit)` for all cloud stores.
- Persist mailbox UID/UIDVALIDITY progress, process already-read messages, and recover matching replies already in the inbox in bounded batches.
- Keep verified TLS, requester/thread matching, size limits, automated-mail rejection and atomic Message-ID deduplication. Do not mark messages read or delete them.
- Add `syncSentEmails(tenant, sink, limit)` to mirror confirmed case notifications into a shared activity history. Sink failures retry without resending SMTP; existing confirmed notifications can backfill.
- Accepted replies appear as public email notes and staff history events.

Install `cookiecasekit@1.2.0`. Configure the monitored reply mailbox and run `pollInbox` every minute alongside `flushEmails`. No database migration is required. Replies must reach that mailbox and retain the case number and original thread reference; unrelated messages are ignored. Each call returns counts and rejection reasons without message bodies. SMTP acceptance is not proof of inbox delivery.

Tests cover conversation/history, read-only polling, replay, UID resets, oversized/forged messages, cross-tenant isolation, failures, concurrent workers and shared activity export. Live mailbox credentials and routing must be verified in the host environment.
