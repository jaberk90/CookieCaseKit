import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { build } from 'esbuild';
import { createTicketing } from '../src/index.js';
import { resolve } from 'node:path';

// Local demonstration only. In your host, replace this fixed identity with verified session data.
const app = express();
app.use(rateLimit({ windowMs: 60_000, limit: 500 }));
const kit = createTicketing({
  database: { filename: ':memory:' },
  ui: false,
  auth: (req) =>
    req.headers.cookie?.includes('demo-support=denied') ||
    (req.headers.cookie?.includes('demo-support=bearer') &&
      req.get('Authorization') !== 'Bearer demo-token')
      ? null
      : {
          id: 'react-admin',
          name: 'Jordan Admin',
          email: 'jordan@example.com',
          role: 'admin',
          tenantId: 'My website',
        },
});
// Your existing contact handler or server action makes this direct method call. No HTTP hop.
kit.createCase(
  {
    title: 'Question from our website contact form',
    description: 'Could you help me choose the right plan?',
    category: 'General',
  },
  { id: 'visitor-1', name: 'Taylor Visitor', email: 'taylor@example.com', tenantId: 'My website' },
);
app.use('/_casekit', kit.router);
// Bundling here is only for this zero-setup demo. Your real React/Vite/Next app owns its build.
const browser = await build({
  entryPoints: ['examples/react-demo-client.tsx'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  define: { 'process.env.NODE_ENV': '"development"' },
});
app.get('/react-app.js', (_req, res) => res.type('js').send(browser.outputFiles[0].text));
app.get('/react.css', (_req, res) => res.sendFile(resolve('dist/react.css')));
app.get('/host.css', (_req, res) =>
  res
    .type('css')
    .send(
      'body{margin:0;font-family:Arial,sans-serif;background:#eef0ed}.host-nav{padding:18px 28px;background:white;border-bottom:1px solid #ddd;color:#24392f}.host-nav a{margin-left:20px;color:#315d48}#host-button{border:0;background:#dce8ff;border-radius:4px;padding:8px 12px;float:right}#support-root{padding:20px}',
    ),
);
app.get('/support', (_req, res) =>
  res
    .type('html')
    .send(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>My website · Support</title><link rel="stylesheet" href="/host.css"><link rel="stylesheet" href="/react.css"></head><body><header class="host-nav">My website<a href="/support">Support</a><button id="host-button">Website button</button></header><div id="support-root"></div><script type="module" src="/react-app.js"></script></body></html>',
    ),
);
const server = app.listen(Number(process.env.PORT ?? 3001), '127.0.0.1', () =>
  console.log(`React host demo → http://127.0.0.1:${process.env.PORT ?? 3001}/support`),
);
process.once('SIGTERM', () =>
  server.close(() => {
    void kit.close();
  }),
);
process.once('SIGINT', () =>
  server.close(() => {
    void kit.close();
  }),
);
