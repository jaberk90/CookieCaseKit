# Google Cloud, AWS and Azure

The 1.0.0 cloud API uses `createCloudTicketing` from `cookiecasekit/cloud`. It is asynchronous and uses durable managed storage. The existing `createTicketing` SQLite API remains available for one persistent Node process; do not put a SQLite file in an ephemeral function filesystem.

See [deployment templates](deployment.md) for Cloud Run/Firebase, Lambda/ECS, and Azure App Service/Functions.

## Provider matrix

| Capability          | Google Cloud                   | AWS                                  | Azure                                               |
| ------------------- | ------------------------------ | ------------------------------------ | --------------------------------------------------- |
| Document database   | `firestoreStore` / Firestore   | `dynamodbStore` / DynamoDB           | `cosmosStore` / Cosmos DB for NoSQL                 |
| SQL database        | Cloud SQL PostgreSQL           | RDS/Aurora PostgreSQL                | Azure Database for PostgreSQL                       |
| Private attachments | `gcsStorage` / Cloud Storage   | `s3Storage` / S3                     | `blobStorage` / Blob Storage                        |
| Email               | SMTP provider                  | `sesSender` / SES or SMTP            | `azureEmailSender` / Communication Services or SMTP |
| Identity            | Firebase Admin verification    | Cognito OIDC                         | Entra ID OIDC                                       |
| Hosting             | Cloud Run / Firebase Functions | ECS / Lambda with an Express adapter | App Service / Functions with an Express adapter     |
| Worker invocation   | Scheduler / Tasks              | EventBridge / SQS                    | Timer Functions / Service Bus                       |

Hosting and queue products invoke the host application; CookieCaseKit does not provision accounts, queues, databases, IAM permissions or managed services. Node 22.13+ is required; use a supported Node 22 or 24 runtime. All cloud SDKs are optional peers: install only the SDKs for the adapters you use. Importing `cookiecasekit/cloud` does not load SQLite or unrelated cloud SDKs.

## Firestore + Firebase authentication

```sh
npm install cookiecasekit @google-cloud/firestore
```

```ts
import { Firestore } from '@google-cloud/firestore';
import { getAuth } from 'firebase-admin/auth'; // Initialize Firebase Admin in the host.
import { createCloudTicketing } from 'cookiecasekit/cloud';
import { firestoreStore } from 'cookiecasekit/firestore';

const caseKit = createCloudTicketing({
  store: firestoreStore(new Firestore()),
  categories: [
    'General question',
    'Something isn’t working',
    'Account or sign-in',
    'Become a Member',
    'Data looks wrong',
    'Feature idea',
  ],
  auth: async (req) => {
    const token = /^Bearer (.+)$/.exec(req.get('Authorization') ?? '')?.[1];
    if (!token) return null;
    try {
      const user = await getAuth().verifyIdToken(token, true);
      if (user.admin !== true || !user.firebase?.sign_in_second_factor) return null;
      return {
        id: user.uid,
        name: user.name || user.email,
        email: user.email,
        tenantId: 'my-website',
        role: 'admin',
      };
    } catch {
      return null;
    }
  },
});
app.use('/api/support', caseKit.router);
```

Use the existing host's stronger account activation, MFA and recent-login policy where applicable. Firestore documents are grouped under a SHA-256 tenant document in collection `cookiecasekit`. Only the server identity may access this collection: deny direct browser Firestore reads/writes. Do not treat Firebase client rules as protection for the privileged server SDK; the package's authorization and host identity mapping are also required.

From your existing contact handler, after CAPTCHA, validation and rate limits:

```ts
const ticket = await caseKit.createCase(
  { title: subject, description: message, category: topicLabel },
  { id: requesterId, name, email, tenantId: 'my-website' },
  { idempotencyKey: submissionId },
);
res.json({ ok: true, caseNumber: ticket.number });
```

Persist/reuse the same submission ID for retries. A reused key with different input returns conflict. Keys are scoped to the tenant; do not accept an unrestricted caller-selected key across different users. Cloud case IDs are random safe integers, not a globally sequential counter. No existing SQLite data is automatically migrated.

## React and bearer tokens

```tsx
import { CaseKit } from 'cookiecasekit/react';
import 'cookiecasekit/react.css';

<CaseKit basePath="/api/support" getToken={() => firebaseUser.getIdToken()} />;
```

`getToken` is called for each request; tokens are not stored by the component. Omit it for cookie-session authentication. The host protects `/support`, and the backend checks every request independently. Keep the API on the same origin (use a development proxy). The package intentionally rejects cross-origin browser writes. Configure Express `trust proxy` only for your trusted proxies when TLS terminates upstream.

## PostgreSQL on any cloud

```sh
npm install cookiecasekit pg
```

```ts
import { Pool } from 'pg';
import { postgresStore } from 'cookiecasekit/postgres';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  max: 5,
});
const store = postgresStore(pool);
await store.initialize(); // Run with migration permissions during deployment, not every request.
const kit = createCloudTicketing({ store, auth: verifiedHostIdentity });
```

The table is `cookiecasekit_documents`, keyed by `(tenant,key)`, with a JSONB payload and revision. Commits use an advisory transaction lock per tenant to protect absent-row checks and multi-document changes. PostgreSQL 17 is used in CI. Runtime roles need SELECT/INSERT/UPDATE, not DDL. Configure connection pooling, verified TLS and backups/PITR. The host owns and closes the pool; the package does not close caller-owned SDK clients.

## DynamoDB

```sh
npm install cookiecasekit @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
```

```ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { dynamodbStore } from 'cookiecasekit/dynamodb';
const store = dynamodbStore(
  DynamoDBDocumentClient.from(new DynamoDBClient({})),
  process.env.CASEKIT_TABLE,
);
const kit = createCloudTicketing({ store, auth: verifiedHostIdentity });
```

Provision string partition key **tenant** and string sort key **key**. Enable encryption and point-in-time recovery. Grant the workload only GetItem, Query and TransactWriteItems on this table. Reads are strongly consistent. Conditional transactional writes protect concurrent edits. Single-region deployments are the supported model; asynchronous global-table replication is not a cross-region transaction guarantee.

## Cosmos DB

```sh
npm install cookiecasekit @azure/cosmos
```

```ts
import { CosmosClient } from '@azure/cosmos';
import { cosmosStore } from 'cookiecasekit/cosmos';
const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
const store = cosmosStore(client.database('support').container('documents'));
const kit = createCloudTicketing({ store, auth: verifiedHostIdentity });
```

Use Cosmos DB **for NoSQL**, partition key **/tenant**, and Session or stronger consistency. ETag conditions and same-partition transactional batches enforce atomic changes. Use managed identity/AAD credentials in production where possible; the connection string is a minimal setup example and belongs in Key Vault. Enable backups and sufficient throughput. Multi-region writes are not validated by this release. The package does not create databases or containers at runtime.

## Identity: Cognito and Entra

```sh
npm install cookiecasekit jose
```

`oidcAuth` from `cookiecasekit/auth` verifies signature, exact issuer/audience, expiry and required sub/iat/exp claims against an HTTPS JWKS endpoint. Supply the expected values from your own identity-provider configuration, never from the incoming token. Map only server-trusted role and tenant claims:

```ts
const auth = oidcAuth({
  issuer: process.env.OIDC_ISSUER,
  audience: process.env.OIDC_AUDIENCE,
  jwksUrl: process.env.OIDC_JWKS_URL,
  mapClaims: (claims) =>
    claims['support_role'] === 'admin'
      ? {
          id: claims.sub,
          name: claims.name,
          email: claims.email,
          tenantId: 'my-website',
          role: 'admin',
        }
      : null,
});
```

Cognito: use an ID-token audience matching your app client and require `token_use === 'id'` in your mapping. Entra: use your tenant-specific issuer, expected API audience and app-role mapping. Your host must also enforce account status, revocation requirements and MFA; offline JWT verification alone cannot immediately detect a revoked session. Existing host authentication callbacks remain the preferred integration when already implemented.

## Private attachments

Install the corresponding peer and configure one storage adapter:

- `gcsStorage(bucket)` from `cookiecasekit/gcs`, with `@google-cloud/storage`.
- `s3Storage(client, bucket)` from `cookiecasekit/s3`, with `@aws-sdk/client-s3`.
- `blobStorage(containerClient)` from `cookiecasekit/blob`, with `@azure/storage-blob`.

```ts
attachments: {storage: s3Storage(s3, bucketName), maxBytes:5 * 1024 * 1024}
```

The React UI displays attachments when configured. Uploads go through authenticated case access, use opaque server-generated object keys, and remain **pending** until a trusted scanning job calls `approveAttachment(tenantId, caseId, attachmentId, 'clean' | 'rejected')`. That method must never be exposed as an unauthenticated route. The package does not include a malware scanner. Wire your provider's scanner/event pipeline, and verify that callbacks are authentic and refer to the uploaded object. Without that integration, downloads remain blocked.

All buckets/containers must stay private; use workload identity and minimal read/write/delete permissions. Downloads pass authorization and private-note rules again and are served as downloads with `nosniff` and a restrictive CSP. The default limit is 5 MiB, configurable up to 20 MiB; uploads/downloads are buffered, so size memory for concurrency. Set a provider lifecycle policy for orphaned objects left by a process crash between upload and metadata commit. Do not apply a lifecycle rule that deletes active attachments.

The current Google Storage SDK has a transitive `gaxios → uuid` advisory in its dependency range. This repository pins the patched UUID implementation via `overrides.gaxios.uuid = "^11.1.1"`. npm does not propagate dependency overrides to consuming apps: apply that override in the host while the upstream dependency remains affected, run your host audit, and remove it when the provider updates its dependency.

## Email and serverless jobs

Configure `email: {from, replyTo, send}`. Sender adapters:

- `smtpSender(options)` from `cookiecasekit/email` — any SMTP service, with bounded connection/socket timeouts.
- `sesSender(client)` from `cookiecasekit/ses` — `@aws-sdk/client-sesv2`, verified sending identity and SES production access as needed.
- `azureEmailSender(client)` from `cookiecasekit/azure-email` — `@azure/communication-email`, verified sender/domain.

Call **`await kit.flushEmails(tenantId)`** from a trusted scheduled worker. Cloud instances create no timers. Use Cloud Scheduler/Tasks, EventBridge/SQS, or Azure Timer Functions/Service Bus to invoke a protected worker entry point. Do not expose a public tenant-selectable worker URL. The host supplies the known tenant list; each call processes up to 25 eligible jobs (maximum 100).

Case mutations and outbox entries commit atomically. Workers claim jobs with five-minute leases and retry up to five attempts with backoff. Sender callbacks must honor their AbortSignal and complete within one minute. Delivery is **at least once**: a process crash after provider acceptance but before acknowledgement can duplicate a message. Monitor exhausted outbox records and reconcile before manually retrying; exactly-once SMTP delivery is not promised.

For incoming mail, verify your provider webhook signature or retrieve mail through an authenticated mailbox worker, then call **`await kit.receiveEmail(tenantId, rawMime)`**. Cloud ingestion validates the requester, case number, message references and duplicate Message-ID in durable storage. It does not poll IMAP automatically. SES rewrites Message-ID; its returned ID is stored for correlation. Validate real reply headers with your provider before going live, including Azure's handling of custom Message-ID. Never trust a plain From address or a case number as authorization.

For the SQLite API only, `backgroundWorkers:false` disables timers so a host scheduler can call its existing worker methods. This does not make ephemeral SQLite safe for serverless use.

## Capacity and rollout limits

Cloud search/statistics currently read tenant case metadata in pages and filter/aggregate in the server. No full-text index or materialized statistics are provisioned. This avoids cross-provider query differences but costs O(tenant case count) reads per request; benchmark cost/latency and add provider-specific query indexes before large deployments. Comments, events and outbox records are separate documents, not an ever-growing case blob. Each document is limited to 300 KB for portability.

The cloud store is new storage, not an automatic import of a SQLite database. Back up existing data and plan an explicit migration. The SQLite and cloud APIs differ in asynchronous behavior; always `await` cloud methods. SDK clients/pools are owned by the host and should be reused across warm invocations.

## Validation before publishing 1.0.0

The local contract tests verify core invariants against an atomic in-memory store. CI runs adapter contracts against PostgreSQL, DynamoDB Local and the Firestore emulator. The opt-in Cosmos test requires a disposable Azure test account and creates/deletes an isolated test database:

```sh
CASEKIT_TEST_BACKEND=cosmos CASEKIT_TEST_COSMOS_CONNECTION='…' npx tsx --test tests/cloud-live.test.ts
```

Never use production resources for test credentials. Run real private-object upload/download, malware scanner, provider email/reply and deployed-host authentication checks for each intended cloud. A passing in-memory test or TypeScript build does not establish provider-level support. **Do not publish the expanded 1.0.0 as fully verified until those deployment checks pass.**

## Request rate limits

Both engines apply a default 300 requests/minute/IP limit before authentication. Configure `rateLimit: {limit, windowMs, store}` to fit the host. For multiple instances, supply a shared express-rate-limit store or enforce a provider WAF/API Gateway limit; the default in-memory store is per instance. Set a precise Express trusted-proxy policy so clients cannot spoof the rate-limit identity.

### Reverse proxies and browser writes

When Firebase Hosting or another proxy rewrites the backend Host header, configure `publicOrigin: 'https://your-site.example'` on `createCloudTicketing`. Use the exact browser-facing origin from trusted deployment configuration. The router compares browser Origin against this value and continues to reject cross-site requests; it never trusts arbitrary forwarded-host headers. Without this option, direct same-origin checking is unchanged.
