import type { EmailClient } from '@azure/communication-email';
import type { CloudConfig } from './core.js';
export function azureEmailSender(client: EmailClient): NonNullable<CloudConfig['email']>['send'] {
  return async (message, signal) => {
    const poller = await client.beginSend(
      {
        senderAddress: message.from,
        recipients: { to: [{ address: message.to }] },
        content: { subject: message.subject, plainText: message.text },
        replyTo: [{ address: message.replyTo }],
        headers: { 'Message-ID': message.messageId },
      },
      { abortSignal: signal },
    );
    const result = await poller.pollUntilDone({ abortSignal: signal });
    if (result.status !== 'Succeeded') throw new Error('Azure email delivery submission failed');
  };
}
