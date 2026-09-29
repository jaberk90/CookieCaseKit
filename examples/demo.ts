import express from 'express';
import { createTicketing } from '../src/index.js';
// Demonstration identity only. Never use a fixed identity in your production host.
const crm = createTicketing({
  database: { filename: process.env.DEMO_DB ?? ':memory:' },
  auth: () => ({
    id: 'alex',
    name: 'Alex Morgan',
    email: 'alex@example.com',
    role: 'admin',
    tenantId: 'Acme Studio',
  }),
});
const app = express();
app.use('/support', crm.router);
app.get('/', (_req, res) => res.redirect('/support/'));
const server = app.listen(Number(process.env.PORT ?? 3000), '127.0.0.1', async () => {
  const address = server.address();
  if (!address || typeof address === 'string') return;
  const base = `http://127.0.0.1:${address.port}/support/api`;
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CookieCaseKit': '1' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  };
  if ((await call('/cases')).total === 0) {
    const seeds = [
      ['Unable to access the analytics dashboard', 'Access & identity', 'high', 'in_progress'],
      ['Update billing contact for the team', 'Billing', 'normal', 'pending'],
      ['SSO login returns an unexpected error', 'Access & identity', 'urgent', 'open'],
      ['Webhook delivery delays in production', 'Infrastructure', 'high', 'in_progress'],
      ['Request access to the staging environment', 'Access & identity', 'normal', 'open'],
      ['Exported report is missing custom fields', 'Product', 'low', 'resolved'],
      ['Increase storage allocation for workspace', 'Infrastructure', 'normal', 'pending'],
      ['A little help with our API integration', 'General', 'low', 'open'],
    ];
    for (const [title, category, priority, status] of seeds.reverse()) {
      const ticket = await call('/cases', 'POST', {
        title,
        category,
        priority,
        description: `${title}.\n\nOur team noticed this while working in the Acme Studio workspace. Please investigate and let us know the next steps.\n\nThanks for your help!`,
      });
      if (status !== 'open')
        await call(`/cases/${ticket.id}`, 'PATCH', {
          version: ticket.version,
          status,
          assigneeId: 'alex',
        });
    }
  }
  console.log(`CookieCaseKit demo → http://127.0.0.1:${address.port}/support/`);
});
async function shutdown() {
  server.close(async () => {
    await crm.close();
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
