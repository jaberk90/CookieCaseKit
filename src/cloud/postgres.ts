import type { Pool } from 'pg';
import type { CaseStore } from './store.js';
/** Uses a caller-owned pool. Run initialize once with a migration role; runtime requires only DML. */
export function postgresStore(pool: Pool): CaseStore & { initialize(): Promise<void> } {
  return {
    async initialize() {
      await pool.query(
        'CREATE TABLE IF NOT EXISTS cookiecasekit_documents (tenant text NOT NULL, key text NOT NULL, revision text NOT NULL, value jsonb NOT NULL, PRIMARY KEY (tenant,key))',
      );
    },
    async read(tenant, key) {
      const { rows } = await pool.query(
        'SELECT key, revision, value FROM cookiecasekit_documents WHERE tenant=$1 AND key=$2',
        [tenant, key],
      );
      return rows[0] ?? null;
    },
    async page(tenant, prefix, cursor = '', limit = 100) {
      const { rows } = await pool.query(
        'SELECT key, revision, value FROM cookiecasekit_documents WHERE tenant=$1 AND starts_with(key,$2) AND key>$3 ORDER BY key LIMIT $4',
        [tenant, prefix, cursor, limit + 1],
      );
      return {
        items: rows.slice(0, limit),
        ...(rows.length > limit ? { cursor: rows[limit - 1].key } : {}),
      };
    },
    async commit(tenant, checks, writes) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Serialize commits within one tenant, including checks for absent documents.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [tenant]);
        for (const check of checks) {
          const { rows } = await client.query(
            'SELECT revision FROM cookiecasekit_documents WHERE tenant=$1 AND key=$2',
            [tenant, check.key],
          );
          if ((rows[0]?.revision ?? null) !== check.revision) {
            await client.query('ROLLBACK');
            return false;
          }
        }
        for (const write of writes)
          await client.query(
            'INSERT INTO cookiecasekit_documents (tenant,key,revision,value) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant,key) DO UPDATE SET revision=EXCLUDED.revision,value=EXCLUDED.value',
            [tenant, write.key, write.revision, write.value],
          );
        await client.query('COMMIT');
        return true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
