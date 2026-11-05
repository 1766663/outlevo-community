import nodemailer from 'nodemailer';
import type { Config } from './config.js';

export type OutMail = { from: string; to: string; subject: string; text: string; headers?: Record<string, string>; inReplyTo?: string; references?: string };
export interface Mailer { send(m: OutMail): Promise<{ messageId: string }>; verify(): Promise<unknown> }

export const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i;
/** Over the network the password goes only inside TLS: someone in between could otherwise strip STARTTLS and read it. */
export const smtpOptions = (c: Config, pass: string) => ({ host: c.smtp.host, port: c.smtp.port, secure: c.smtp.secure, requireTLS: !c.smtp.secure && !LOOPBACK.test(c.smtp.host), auth: { user: c.smtp.user, pass } });

export function makeMailer(c: Config, s: { smtp_password?: string | undefined }): Mailer {
  if (!c.smtp.host || !c.smtp.user || !s.smtp_password) throw new Error('Set your mailbox first: smtp.host and smtp.user in the config, and OUTLEVO_SMTP_PASSWORD');
  const t = nodemailer.createTransport(smtpOptions(c, s.smtp_password));
  return { send: async (m) => ({ messageId: (await t.sendMail(m)).messageId }), verify: () => t.verify() };
}
