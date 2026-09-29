import express from 'express';
import { createTicketing, type User } from '../src/index.js'; // Use 'cookiecasekit' after installation.
const app = express();
// Install your real session/JWT middleware BEFORE this mount. It must verify identities.
const ticketing = createTicketing({
  database: { filename: './support.db' },
  auth: (req) => (req as typeof req & { user?: User }).user ?? null,
  brand: { name: 'Acme Support' },
  categories: ['General', 'Billing', 'Engineering'],
  slaHours: { urgent: 2, high: 12 },
  ...(process.env.SMTP_HOST
    ? {
        email: {
          from: process.env.SMTP_FROM!,
          replyTo: process.env.SMTP_REPLY_TO,
          ...(process.env.IMAP_HOST
            ? {
                inbound: {
                  connection: {
                    host: process.env.IMAP_HOST,
                    port: Number(process.env.IMAP_PORT ?? 993),
                    secure: true,
                    auth: { user: process.env.IMAP_USER!, pass: process.env.IMAP_PASSWORD! },
                  },
                  mailbox: process.env.IMAP_MAILBOX ?? 'INBOX',
                },
              }
            : {}),
          publicUrl: 'https://your-app.example/support',
          transport: {
            host: process.env.SMTP_HOST,
            port: 587,
            secure: false,
            requireTLS: true,
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
          },
        },
      }
    : {}),
});
app.use('/support', ticketing.router);
const server = app.listen(3000);
process.once('SIGTERM', () =>
  server.close(() => {
    void ticketing.close();
  }),
);
