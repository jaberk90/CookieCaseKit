# Contact form with a private admin console

**For an existing Node application, call `support.createCase()` directly from your current form handler or server action. You do not need a new REST endpoint.** For an embedded React `/support` page, follow [the Node + React guide](REACT.md).

The optional example below is only for websites that want a new HTTP submission endpoint. It uses two separate routes:

| Route                           | Who can use it                        | What it does                                                 |
| ------------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| `POST /api/contact`             | Website visitors                      | Submits a new request and returns its reference number only. |
| `/support` and `/support/api/*` | Logged-in users with `support:access` | Opens the console and manages cases.                         |

The contact form never links to `/support`. Knowing the `/support` URL does not grant access: the package runs your authentication callback on the page, assets, and every API request. A hidden menu link alone is not authorization.

## Backend integration

The complete, tested example is [examples/contact-us.ts](../examples/contact-us.ts). Copy it into your website's server and change its package import from `../src/index.js` to `cookiecasekit`.

Mount it **after your existing session/authentication middleware**. Adapt `getCurrentUser` to the fields your verified session provides:

```ts
import express from 'express';
import { createContactWebsite } from './contact-us.js'; // The copied example.

const app = express();
app.use(yourExistingSessionMiddleware);

const { app: contactAndSupport, support } = createContactWebsite({
  database: { filename: './support.db' },
  tenantId: 'my-website',
  getCurrentUser: (req) => {
    // req.user must be populated by your server's verified session middleware.
    const current = req.user;
    if (!current) return null;
    return {
      id: String(current.id),
      displayName: current.fullName,
      email: current.email,
      // This role must come from your database/session, never a form or request header.
      permissions: current.role === 'admin' ? ['support:access'] : [],
    };
  },
  protectContact: yourExistingContactFormProtection,
  // Optional: email: { from, replyTo, transport, inbound }
});

app.use(contactAndSupport);
const server = app.listen(3000);
process.once('SIGTERM', () =>
  server.close(() => {
    void support.close();
  }),
);
```

`yourExistingSessionMiddleware` and `yourExistingContactFormProtection` stand for your website's real middleware. The contact protection receives the parsed JSON body, so it can use your existing rate limiting and spam/CAPTCHA verification. No fake login or hard-coded admin is provided. Your host also owns the TypeScript declaration for `req.user` and its normal error handler.

For a narrower staff permission, map your application's existing `canManageSupport` permission to `support:access` instead of granting access to every admin. Anonymous visitors and logged-in users without that permission receive 401 from this example; your website can redirect browser navigation to its own login page before the mount if desired. Always keep the backend permission check.

## Where names come from

There are two different identities:

- **Admin profile name:** the authenticated user's `displayName`, mapped to CookieCaseKit's `User.name`. This appears in the console profile, authored replies, and audit events. The example maps your `req.user.fullName` to it. CookieCaseKit does not create or look up a separate admin account.
- **Contact requester name:** the `name` submitted with the contact form. It is saved on that case together with the visitor's email. This is a claimed contact identity, not a login or a grant of portal access.

The website integration creates a random requester ID for each contact submission and fixes the tenant, category, and priority on the server. Sending `role`, `tenantId` or a different category from the browser has no effect.

## Connect your existing contact form

Submit just the contact fields to your website endpoint, together with any verification token required by your form protection:

```js
const response = await fetch('/api/contact', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: form.name.value,
    email: form.email.value,
    subject: form.subject.value,
    message: form.message.value,
    // captchaToken: yourVerifiedWidgetToken,
  }),
});
const result = await response.json();
if (!response.ok) throw new Error(result.error || 'Could not submit your request');
confirmation.textContent = `Thanks! Your reference is ${result.reference}.`;
```

The response contains only `{ reference, message }`, not a case URL, requester ID, notes, or an authentication token. There is no public list/detail/update route for these requests. The form does not call `/support/api/cases`.

## Server-side API used by the example

`support.createCase(input, requester)` is a synchronous **trusted server-only** method. It validates input, writes the case and creation event, and queues the same notification as the authenticated case-creation API. It returns the created `Case`. `TicketingError` carries a `status` and safe validation message; handle unexpected errors through your host's normal error handler.

```ts
const ticket = support.createCase(
  { title: subject, description: message, category: 'Contact', priority: 'normal' },
  { id: `contact:${crypto.randomUUID()}`, name, email, tenantId: 'my-website' },
);
```

This method intentionally does not call HTTP authentication: your server controls its invocation. Do not expose a generic endpoint accepting the whole requester object from a browser. The tested example maps only `name`, `email`, `subject`, and `message` from the public body.

## Email for contact requests

SMTP configuration queues a receipt to the visitor's submitted email. With the optional IMAP inbox configured, their replies are added as public case notes after thread/sender checks. Admins see those notes inside the private console.

The example deliberately omits `email.publicUrl`, even if supplied at runtime, so visitor notifications do not link to the private `/support` page. Configure `replyTo` to your inbound mailbox. Without real SMTP/IMAP settings, cases still appear in the console but no mail is sent or collected.
