import type { Request } from 'express';
import type { Store } from 'express-rate-limit';
import type { ImapFlowOptions } from 'imapflow';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
export type Role = 'requester' | 'agent' | 'admin';
export type Status = 'open' | 'in_progress' | 'pending' | 'resolved' | 'closed';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  tenantId: string;
}
/** Requester identity supplied only by trusted server-side integrations. */
export type Requester = Omit<User, 'role'>;
export interface CreateCaseInput {
  title: string;
  description: string;
  priority?: Priority;
  category?: string;
}
export interface Case {
  id: number;
  number: string;
  tenantId: string;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  category: string;
  requesterId: string;
  requesterName: string;
  requesterEmail: string;
  assigneeId: string | null;
  createdAt: string;
  updatedAt: string;
  dueAt: string;
  version: number;
}
export interface Comment {
  source: 'web' | 'email';
  id: number;
  caseId: number;
  authorId: string;
  authorName: string;
  body: string;
  internal: boolean;
  createdAt: string;
}
export interface Event {
  id: number;
  caseId: number;
  actorName: string;
  action: string;
  createdAt: string;
}
export interface InboundEmailConfig {
  connection: Pick<ImapFlowOptions, 'host' | 'secure' | 'auth' | 'tls' | 'doSTARTTLS'> & {
    port: number;
  };
  mailbox?: string;
  pollIntervalMs?: number;
}
export type InboundEmailResult =
  | { status: 'accepted' | 'duplicate'; caseId: number; commentId: number }
  | { status: 'ignored'; reason: string };
export interface Config {
  /** Default 300 requests/minute/IP; supply a shared store for distributed deployments. */
  rateLimit?: { limit?: number; windowMs?: number; store?: Store };
  /** Disable timers and invoke flushEmails/pollInbox from a scheduler instead. */
  backgroundWorkers?: boolean;
  /** Disable the standalone HTML console when embedding the React component. */
  ui?: boolean;
  database: { filename: string };
  auth: (req: Request) => User | null | Promise<User | null>;
  brand?: { name?: string; accent?: string };
  categories?: string[];
  slaHours?: Partial<Record<Priority, number>>;
  email?: {
    from: string;
    replyTo?: string;
    inbound?: InboundEmailConfig;
    transport: SMTPTransport.Options;
    publicUrl?: string;
    pollIntervalMs?: number;
  };
  logger?: { error: (message: string, error?: unknown) => void };
}
