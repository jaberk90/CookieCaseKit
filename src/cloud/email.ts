import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { CloudConfig } from './core.js';
type Sender = NonNullable<CloudConfig['email']>['send'];
/** Each attempt owns its transport so cancellation cannot interrupt another worker. */
export function smtpSender(options: SMTPTransport.Options): Sender {
  return async (message, signal) => {
    signal.throwIfAborted();
    const transport = nodemailer.createTransport({
      ...options,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 60000,
    });
    const abort = () => transport.close();
    signal.addEventListener('abort', abort, { once: true });
    try {
      await transport.sendMail({ ...message, disableFileAccess: true, disableUrlAccess: true });
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener('abort', abort);
      transport.close();
    }
  };
}
export async function rawMessage(message: Parameters<Sender>[0]): Promise<Uint8Array> {
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'windows',
  });
  const result = await transport.sendMail({
    ...message,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  if (!Buffer.isBuffer(result.message)) throw new Error('Expected buffered MIME message');
  return result.message;
}
