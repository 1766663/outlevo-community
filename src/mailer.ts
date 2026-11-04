import nodemailer from 'nodemailer';
import type { Config } from './config.js';

export type OutMail = { from: string; to: string; subject: string; text: string; headers?: Record<string, string>; inReplyTo?: string; references?: string };
export interface Mailer { send(m: OutMail): Promise<{ messageId: string }> }

export function makeMailer(c: Config, s: { smtp_password?: string | undefined }): Mailer {
  if (!c.smtp.host || !c.smtp.user || !s.smtp_password) throw new Error('Set your mailbox first: smtp.host and smtp.user in the config, and OUTLEVO_SMTP_PASSWORD');
  const t = nodemailer.createTransport({ host: c.smtp.host, port: c.smtp.port, secure: c.smtp.secure, auth: { user: c.smtp.user, pass: s.smtp_password } });
  return { send: async (m) => ({ messageId: (await t.sendMail(m)).messageId }) };
}
