import { SendEmailCommand, type SESv2Client } from '@aws-sdk/client-sesv2';
import { rawMessage } from './email.js';
import type { CloudConfig } from './core.js';
/** SES overwrites Message-ID; return-path correlation must use a provider webhook or stored service ID. */
export function sesSender(client: SESv2Client): NonNullable<CloudConfig['email']>['send'] {
  return async (message, signal) => {
    const r = await client.send(
      new SendEmailCommand({
        FromEmailAddress: message.from,
        Destination: { ToAddresses: [message.to] },
        Content: { Raw: { Data: await rawMessage(message) } },
      }),
      { abortSignal: signal },
    );
    return r.MessageId ? { messageId: `<${r.MessageId}@email.amazonses.com>` } : undefined;
  };
}
