import type { createCloudTicketing } from '../../src/cloud/index.js';

/** Call only from an authenticated scheduler/queue, with a server-owned tenant list. */
export function scheduledWorker(kit: ReturnType<typeof createCloudTicketing>, tenants: string[]) {
  return async () => {
    const results = [];
    for (const tenant of tenants) results.push({ tenant, ...(await kit.flushEmails(tenant)) });
    return results;
  };
}
