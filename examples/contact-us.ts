import express from 'express';
import type { Request, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { createTicketing, TicketingError, type Config } from '../src/index.js'; // Use 'cookiecasekit' after installation.

/** Adapt this shape to the user returned by YOUR verified session/auth provider. */
export interface WebsiteUser {
  id: string;
  displayName: string;
  email: string;
  permissions: string[];
}
interface Options {
  database: Config['database'];
  tenantId: string; // Set by the server. Never accept this value from the contact form.
  getCurrentUser: (req: Request) => WebsiteUser | null | Promise<WebsiteUser | null>;
  protectContact: RequestHandler; // Your website's contact-form rate limit / spam protection.
  email?: Omit<NonNullable<Config['email']>, 'publicUrl'>;
}

/** Mount the returned app after your existing authentication/session middleware. */
export function createContactWebsite(options: Options) {
  const app = express();
  const support = createTicketing({
    database: options.database,
    categories: ['Contact', 'Billing', 'Technical'],
    auth: async (req) => {
      const currentUser = await options.getCurrentUser(req);
      if (!currentUser?.permissions.includes('support:access')) return null;
      return {
        id: currentUser.id,
        name: currentUser.displayName, // Displayed in the profile, replies and audit trail.
        email: currentUser.email,
        role: 'admin',
        tenantId: options.tenantId,
      };
    },
    // Contact recipients must not receive a link to the private admin console.
    ...(options.email ? { email: { ...options.email, publicUrl: undefined } } : {}),
  });

  // auth() protects the ENTIRE mount: the UI, static assets and every support API route.
  app.use('/support', support.router);

  // Public submission only. This route never returns cases, notes, user roles or a support URL.
  app.post(
    '/api/contact',
    (req, res, next) => {
      if (!req.is('application/json')) {
        res.status(415).json({ error: 'Send application/json' });
        return;
      }
      next();
    },
    express.json({ limit: '24kb' }),
    options.protectContact,
    (req, res, next) => {
      try {
        const { name, email, subject, message } = req.body ?? {};
        const ticket = support.createCase(
          { title: subject, description: message, category: 'Contact', priority: 'normal' },
          { id: `contact:${randomUUID()}`, name, email, tenantId: options.tenantId },
        );
        res.status(201).json({ reference: ticket.number, message: 'Your request was received.' });
      } catch (error) {
        if (error instanceof TicketingError)
          res.status(error.status).json({ error: error.message });
        else next(error); // Let your application's error handler log unexpected failures.
      }
    },
  );
  return { app, support };
}
