import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { CaseStore, StoredDocument } from './store.js';
/** Table keys: tenant (string partition key), key (string sort key). No public/client access. */
export function dynamodbStore(client: DynamoDBDocumentClient, tableName: string): CaseStore {
  return {
    async read(tenant, key) {
      const r = await client.send(
        new GetCommand({ TableName: tableName, Key: { tenant, key }, ConsistentRead: true }),
      );
      return (r.Item as StoredDocument) ?? null;
    },
    async page(tenant, prefix, cursor, limit = 100) {
      const r = await client.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: '#t=:t AND begins_with(#k,:p)',
          ExpressionAttributeNames: { '#t': 'tenant', '#k': 'key' },
          ExpressionAttributeValues: { ':t': tenant, ':p': prefix },
          ConsistentRead: true,
          Limit: limit,
          ...(cursor ? { ExclusiveStartKey: { tenant, key: cursor } } : {}),
        }),
      );
      return {
        items: (r.Items ?? []) as StoredDocument[],
        ...(r.LastEvaluatedKey ? { cursor: r.LastEvaluatedKey.key as string } : {}),
      };
    },
    async commit(tenant, checks, writes) {
      if (checks.length > 100) throw new Error('DynamoDB transaction exceeds 100 documents');
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: checks.map((check) => {
              const write = writes.find((w) => w.key === check.key);
              const condition: {
                ConditionExpression: string;
                ExpressionAttributeNames: Record<string, string>;
                ExpressionAttributeValues?: Record<string, string>;
              } =
                check.revision === null
                  ? {
                      ConditionExpression: 'attribute_not_exists(#k)',
                      ExpressionAttributeNames: { '#k': 'key' },
                    }
                  : {
                      ConditionExpression: '#r=:r',
                      ExpressionAttributeNames: { '#r': 'revision' },
                      ExpressionAttributeValues: { ':r': check.revision },
                    };
              return write
                ? { Put: { TableName: tableName, Item: { tenant, ...write }, ...condition } }
                : {
                    ConditionCheck: {
                      TableName: tableName,
                      Key: { tenant, key: check.key },
                      ...condition,
                    },
                  };
            }),
          }),
        );
        return true;
      } catch (error) {
        const e = error as { name?: string; CancellationReasons?: { Code?: string }[] };
        if (
          e.name === 'TransactionCanceledException' &&
          e.CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed')
        )
          return false;
        throw error;
      }
    },
  };
}
