import type { Container, OperationInput } from '@azure/cosmos';
import type { CaseStore, StoredDocument } from './store.js';
/** Container partition key MUST be /tenant. SDK consistency should be Session or stronger. */
export function cosmosStore(container: Container): CaseStore {
  return {
    async read(tenant, key) {
      try {
        const { resource } = await container.item(key, tenant).read();
        return resource ? { key, revision: resource._etag, value: resource.value } : null;
      } catch (error) {
        if ((error as { code?: number }).code === 404) return null;
        throw error;
      }
    },
    async page(tenant, prefix, cursor = '', limit = 100) {
      const { resources } = await container.items
        .query(
          {
            query:
              'SELECT TOP @limit c.id, c._etag, c.value FROM c WHERE c.tenant = @tenant AND STARTSWITH(c.id, @prefix) AND c.id > @cursor ORDER BY c.id',
            parameters: [
              { name: '@limit', value: limit + 1 },
              { name: '@tenant', value: tenant },
              { name: '@prefix', value: prefix },
              { name: '@cursor', value: cursor },
            ],
          },
          { partitionKey: tenant },
        )
        .fetchAll();
      return {
        items: resources
          .slice(0, limit)
          .map((r) => ({ key: r.id, revision: r._etag, value: r.value }) as StoredDocument),
        ...(resources.length > limit ? { cursor: resources[limit - 1].id } : {}),
      };
    },
    async commit(tenant, checks, writes) {
      // Cosmos has no standalone condition-check operation: replace checked, unchanged documents
      // with If-Match in the same partition batch to validate the entire read set atomically.
      const operations: OperationInput[] = [];
      for (const check of checks) {
        const write = writes.find((w) => w.key === check.key);
        if (check.revision === null) {
          if (!write)
            throw new Error('Cosmos cannot assert an absent document without creating it');
          operations.push({
            operationType: 'Create',
            resourceBody: { id: check.key, tenant, value: JSON.parse(JSON.stringify(write.value)) },
          });
        } else {
          let value = write?.value;
          if (!value) {
            const current = await this.read(tenant, check.key);
            if (!current || current.revision !== check.revision) return false;
            value = current.value;
          }
          operations.push({
            operationType: 'Replace',
            id: check.key,
            ifMatch: check.revision,
            resourceBody: { id: check.key, tenant, value: JSON.parse(JSON.stringify(value)) },
          });
        }
      }
      const result = await container.items.batch(operations, tenant);
      if (
        result.code === 409 ||
        result.code === 412 ||
        result.result?.some((r) => r.statusCode === 409 || r.statusCode === 412)
      )
        return false;
      if (!result.code || result.code >= 400)
        throw new Error(`Cosmos transaction failed (${result.code})`);
      return true;
    },
  };
}
