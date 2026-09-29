import { randomUUID } from 'node:crypto';

export interface StoredDocument {
  key: string;
  revision: string;
  value: Record<string, unknown>;
}
export interface StorePage {
  items: StoredDocument[];
  cursor?: string;
}
export interface StoreCheck {
  key: string;
  revision: string | null;
}
export interface StoreWrite {
  key: string;
  revision: string;
  value: Record<string, unknown>;
}
/** Server-only, tenant-partitioned document store. Commit must atomically verify ALL reads and apply ALL writes. */
export interface CaseStore {
  read(tenant: string, key: string): Promise<StoredDocument | null>;
  page(tenant: string, prefix: string, cursor?: string, limit?: number): Promise<StorePage>;
  commit(tenant: string, checks: StoreCheck[], writes: StoreWrite[]): Promise<boolean>;
  close?(): Promise<void>;
}
export class ConflictError extends Error {}
export async function atomic<T>(
  store: CaseStore,
  tenant: string,
  work: (tx: {
    get(key: string): Promise<Record<string, unknown> | null>;
    put(key: string, value: Record<string, unknown>): void;
  }) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const reads = new Map<string, StoredDocument | null>();
    const writes = new Map<string, StoreWrite>();
    const result = await work({
      async get(key) {
        if (writes.has(key)) return structuredClone(writes.get(key)!.value);
        if (!reads.has(key)) reads.set(key, await store.read(tenant, key));
        return structuredClone(reads.get(key)?.value ?? null);
      },
      put(key, value) {
        if (!reads.has(key)) throw new Error('Read a document before writing it');
        if (Buffer.byteLength(JSON.stringify(value)) > 300_000)
          throw new Error('Document exceeds portable storage limit');
        writes.set(key, { key, revision: randomUUID(), value: structuredClone(value) });
      },
    });
    if (
      !writes.size ||
      (await store.commit(
        tenant,
        [...reads].map(([key, value]) => ({ key, revision: value?.revision ?? null })),
        [...writes.values()],
      ))
    )
      return result;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(100, 2 ** attempt) + Math.random() * 10),
    );
  }
  throw new ConflictError('Concurrent change; retry the operation');
}
export async function* documents(store: CaseStore, tenant: string, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await store.page(tenant, prefix, cursor, 100);
    for (const item of page.items) yield item;
    if (page.cursor && page.cursor === cursor) throw new Error('Storage cursor did not advance');
    cursor = page.cursor;
  } while (cursor);
}
