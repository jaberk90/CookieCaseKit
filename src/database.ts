import { DatabaseSync } from 'node:sqlite';
export function openDatabase(filename: string) {
  const db = new DatabaseSync(filename);
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get();
  if (exists) {
    const version = Number(
      db.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version,
    );
    if (![1, 2].includes(version)) {
      db.close();
      throw new Error('Unsupported database schema version');
    }
  }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
    INSERT OR IGNORE INTO schema_version VALUES (1);
    CREATE TABLE IF NOT EXISTS cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT UNIQUE, tenantId TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', priority TEXT NOT NULL,
      category TEXT NOT NULL, requesterId TEXT NOT NULL, requesterName TEXT NOT NULL, requesterEmail TEXT NOT NULL,
      assigneeId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, dueAt TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS cases_tenant ON cases(tenantId, updatedAt);
    CREATE INDEX IF NOT EXISTS cases_requester ON cases(tenantId, requesterId);
    CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, caseId INTEGER NOT NULL REFERENCES cases(id), authorId TEXT NOT NULL, authorName TEXT NOT NULL, body TEXT NOT NULL, internal INTEGER NOT NULL, createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, caseId INTEGER NOT NULL REFERENCES cases(id), actorName TEXT NOT NULL, action TEXT NOT NULL, createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, nextAttempt TEXT NOT NULL, sentAt TEXT);
  `);
  if (db.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version === 1) {
    transaction(db, () => {
      db.exec(`ALTER TABLE outbox ADD COLUMN caseId INTEGER REFERENCES cases(id);
        ALTER TABLE outbox ADD COLUMN messageId TEXT;
        CREATE UNIQUE INDEX outbox_message_id ON outbox(messageId);
        ALTER TABLE comments ADD COLUMN source TEXT NOT NULL DEFAULT 'web';
        CREATE TABLE inbound_messages (messageId TEXT PRIMARY KEY, caseId INTEGER NOT NULL REFERENCES cases(id), commentId INTEGER NOT NULL REFERENCES comments(id), receivedAt TEXT NOT NULL);
        CREATE TABLE inbox_cursors (mailboxKey TEXT NOT NULL, uidValidity TEXT NOT NULL, lastUid INTEGER NOT NULL, PRIMARY KEY(mailboxKey, uidValidity));
      `);
      for (const row of db.prepare('SELECT id, subject FROM outbox').all()) {
        const number = String(row.subject).match(/\[(CS-\d+)\]/)?.[1];
        if (number)
          db.prepare(
            'UPDATE outbox SET caseId = (SELECT id FROM cases WHERE number = ?) WHERE id = ?',
          ).run(number, row.id);
      }
      db.exec('INSERT INTO schema_version VALUES (2)');
    });
  }
  return db;
}
export function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
