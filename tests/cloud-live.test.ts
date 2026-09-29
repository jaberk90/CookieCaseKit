import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCloudTicketing } from '../src/cloud/core.js';
import { atomic } from '../src/cloud/store.js';
import type { CaseStore } from '../src/cloud/store.js';
import type { User } from '../src/types.js';

// Explicit opt-in: CI provisions disposable services; never point these at production resources.
for (const backend of ['postgres', 'firestore', 'dynamodb', 'cosmos']) {
  test(
    `live ${backend}: atomic commits, concurrent idempotency, tenant isolation and worker leases`,
    { skip: process.env.CASEKIT_TEST_BACKEND !== backend },
    async (t) => {
      let store: CaseStore;
      const suffix = randomUUID().replaceAll('-', '');
      if (backend === 'postgres') {
        const { Pool } = await import('pg');
        const { postgresStore } = await import('../src/cloud/postgres.js');
        const pool = new Pool({ connectionString: process.env.CASEKIT_TEST_POSTGRES_URL });
        const adapter = postgresStore(pool);
        await adapter.initialize();
        store = adapter;
        t.after(() => pool.end());
      } else if (backend === 'firestore') {
        const { Firestore } = await import('@google-cloud/firestore');
        const { firestoreStore } = await import('../src/cloud/firestore.js');
        const db = new Firestore({
          projectId: process.env.CASEKIT_TEST_GOOGLE_PROJECT ?? 'casekit-test',
        });
        store = firestoreStore(db, 'test_' + suffix);
        t.after(() => db.terminate());
      } else if (backend === 'dynamodb') {
        const { DynamoDBClient, CreateTableCommand, DeleteTableCommand, waitUntilTableExists } =
          await import('@aws-sdk/client-dynamodb');
        const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
        const { dynamodbStore } = await import('../src/cloud/dynamodb.js');
        const client = new DynamoDBClient({
          region: 'us-east-1',
          ...(process.env.CASEKIT_TEST_DYNAMO_ENDPOINT
            ? {
                endpoint: process.env.CASEKIT_TEST_DYNAMO_ENDPOINT,
                credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
              }
            : {}),
        });
        const table = 'casekit-test-' + suffix;
        await client.send(
          new CreateTableCommand({
            TableName: table,
            KeySchema: [
              { AttributeName: 'tenant', KeyType: 'HASH' },
              { AttributeName: 'key', KeyType: 'RANGE' },
            ],
            AttributeDefinitions: [
              { AttributeName: 'tenant', AttributeType: 'S' },
              { AttributeName: 'key', AttributeType: 'S' },
            ],
            BillingMode: 'PAY_PER_REQUEST',
          }),
        );
        await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: table });
        store = dynamodbStore(DynamoDBDocumentClient.from(client), table);
        t.after(async () => {
          await client.send(new DeleteTableCommand({ TableName: table }));
          client.destroy();
        });
      } else {
        const { CosmosClient } = await import('@azure/cosmos');
        const { cosmosStore } = await import('../src/cloud/cosmos.js');
        const client = new CosmosClient(process.env.CASEKIT_TEST_COSMOS_CONNECTION!);
        const { database } = await client.databases.create({ id: 'casekit-test-' + suffix });
        const { container } = await database.containers.create({
          id: 'documents',
          partitionKey: { paths: ['/tenant'] },
        });
        store = cosmosStore(container);
        t.after(async () => {
          await database.delete();
          client.dispose();
        });
      }
      const tenant = 'test-' + suffix;
      const actor: User = {
        id: 'customer',
        name: 'Customer',
        email: 'customer@example.com',
        tenantId: tenant,
        role: 'requester',
      };
      let sends = 0;
      const kit = createCloudTicketing({
        store,
        auth: () => actor,
        email: {
          from: 'help@example.com',
          async send() {
            sends++;
            await new Promise((r) => setTimeout(r, 20));
          },
        },
      });
      const items = await Promise.all(
        Array.from({ length: 4 }, () =>
          kit.createCase(
            { title: 'Concurrent contact', description: 'Created by adapter contract test' },
            actor,
            { idempotencyKey: 'contact-1' },
          ),
        ),
      );
      assert.equal(new Set(items.map((c) => c.id)).size, 1);
      const c = items[0];
      const admin = { ...actor, id: 'staff', role: 'admin' as const };
      await kit.addComment(c.id, { body: 'Private note', internal: true }, admin);
      assert.equal((await kit.getCase(c.id, actor)).comments.length, 0);
      assert.equal((await kit.getCase(c.id, admin)).comments.length, 1);
      await assert.rejects(kit.getCase(c.id, { ...admin, tenantId: 'different' }), /not found/);
      await Promise.all([kit.flushEmails(tenant), kit.flushEmails(tenant)]);
      assert.equal(sends, 1);
      const counter = 'counter';
      await atomic(store, tenant, async (tx) => {
        await tx.get(counter);
        tx.put(counter, { n: 0 });
      });
      await Promise.all(
        Array.from({ length: 4 }, () =>
          atomic(store, tenant, async (tx) => {
            const value = await tx.get(counter);
            tx.put(counter, { n: Number(value!.n) + 1 });
          }),
        ),
      );
      assert.equal((await store.read(tenant, counter))!.value.n, 4);
      const page = await store.page(tenant, 'case-', undefined, 1);
      assert.equal(page.items.length, 1);
      assert.equal((await store.page('other', 'case-')).items.length, 0);
    },
  );
}
