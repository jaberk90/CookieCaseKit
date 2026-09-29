# Deployment templates

These are host-application templates, not deployable accounts or managed infrastructure. Configure the database and auth callback as shown in the cloud guide. Keep secrets in each provider's secret manager or workload identity. Never ship database credentials in the React build.

## Google Cloud Run / Firebase Functions

For Cloud Run use the [host Dockerfile](../../examples/cloud/Dockerfile), a service identity authorized only for the support collection/bucket, and an authenticated Cloud Scheduler target for the worker. The web API verifies the end-user identity independently.

For Firebase Functions v2, initialize the kit once per warm instance and invoke the Express app:

```ts
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';

export const supportApi = onRequest({ region: 'us-central1', timeoutSeconds: 60 }, app);
export const supportMail = onSchedule(
  { schedule: 'every 1 minutes', region: 'us-central1', timeoutSeconds: 300 },
  async () => {
    await kit.flushEmails('my-website');
  },
);
```

Use Firestore; do not use temporary SQLite. Configure the supported Node 22+ runtime in the Firebase host, install provider dependencies in that host's functions directory, and keep `/api/support/**` rewrites on the same origin as React. Do not use a public scheduler route. The outbox worker has no browser identity because it is a privileged scheduled function.

## AWS Lambda / ECS

Containers on ECS/Fargate use the same Express app and Dockerfile. For Lambda, install an Express-to-Lambda adapter such as `@codegenie/serverless-express` in the host, then export:

```ts
import serverlessExpress from '@codegenie/serverless-express';
export const handler = serverlessExpress({ app });
export const mailWorker = async () => kit.flushEmails('my-website');
```

Route API Gateway to `handler` and a private EventBridge schedule to `mailWorker`. Use separate IAM roles: API needs only the case table and private attachment bucket; worker additionally needs SES sending permissions. Only a trusted invocation path may select a tenant. DynamoDB keys are `tenant`/`key`; use PostgreSQL with RDS Proxy if choosing SQL. Keep SDK clients outside handlers for reuse. Configure finite SDK timeouts/retries and Lambda concurrency appropriate to database throughput.

## Azure App Service / Functions

App Service containers run the same Express app using the Dockerfile. Use managed identity for Cosmos DB and Blob Storage, and private connectivity where required. Cosmos requires `/tenant` partitioning.

Azure Functions uses its own HTTP request/response types; use a host-tested Express adapter rather than passing the Express router directly as a Functions v4 handler. A timer worker can invoke the package directly:

```ts
import { app as functions } from '@azure/functions';
functions.timer('supportMail', {
  schedule: '0 * * * * *',
  handler: async () => {
    await kit.flushEmails('my-website');
  },
});
```

The package does not bundle Azure Functions or a framework HTTP adapter. Pin and verify that adapter in your host. Event-driven Service Bus workers can call the same method after validating the job's server-owned tenant scope.

## Required release checks

For each deployment, test an actual authenticated contact submission, role denial, tenant isolation, restart persistence, concurrent workers, mail delivery/reply ingestion, attachment quarantine/download, backups and restore. Test workload IAM with least privilege. Resource creation, billing, region selection and production deployment are host-owner decisions; these examples do not deploy anything automatically.
