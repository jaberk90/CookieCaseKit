import { createHash } from 'node:crypto';
import type { Firestore } from '@google-cloud/firestore';
import type { CaseStore } from './store.js';
export function firestoreStore(db: Firestore, collection = 'cookiecasekit'): CaseStore {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(collection)) throw new Error('Invalid collection name');
  const partition = (tenant: string) =>
    db
      .collection(collection)
      .doc(createHash('sha256').update(tenant).digest('hex'))
      .collection('documents');
  return {
    async read(tenant, key) {
      const doc = await partition(tenant).doc(key).get();
      return doc.exists ? (doc.data() as never) : null;
    },
    async page(tenant, prefix, cursor, limit = 100) {
      let query = partition(tenant)
        .orderBy('key')
        .where('key', '>=', prefix)
        .where('key', '<', prefix + '\uf8ff');
      if (cursor) query = query.startAfter(cursor);
      const result = await query.limit(limit + 1).get();
      return {
        items: result.docs.slice(0, limit).map((doc) => doc.data() as never),
        ...(result.size > limit ? { cursor: result.docs[limit - 1].get('key') as string } : {}),
      };
    },
    async commit(tenant, checks, writes) {
      return db.runTransaction(async (tx) => {
        const refs = checks.map((c) => partition(tenant).doc(c.key));
        const docs = await tx.getAll(...refs);
        if (docs.some((doc, i) => (doc.exists ? doc.get('revision') : null) !== checks[i].revision))
          return false;
        for (const write of writes) tx.set(partition(tenant).doc(write.key), write);
        return true;
      });
    },
  };
}
