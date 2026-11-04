import { afterEach, describe, expect, it } from 'vitest';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { DEFAULTS } from '../src/config.js';
import { makeMailer } from '../src/mailer.js';

let stop: (() => void) | undefined;
afterEach(() => stop?.());

describe('makeMailer', () => {
  it('refuses to start without a mailbox', () => {
    expect(() => makeMailer(structuredClone(DEFAULTS), {})).toThrow(/Set your mailbox/);
  });
  it('logs in and delivers over real SMTP, headers included', async () => {
    let raw = ''; let user = '';
    const server = new SMTPServer({
      authOptional: false, disabledCommands: ['STARTTLS'], allowInsecureAuth: true,
      onAuth: (a, _s, cb) => { user = a.username ?? ''; cb(a.password === 'secret' ? null : new Error('no'), { user: a.username }); },
      onData: (s, _x, cb) => { s.on('data', (c) => (raw += c)); s.on('end', () => cb()); },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    stop = () => server.close();
    const c = structuredClone(DEFAULTS);
    c.smtp = { host: '127.0.0.1', port: (server.server.address() as any).port, secure: false, user: 'sam' };
    const res = await makeMailer(c, { smtp_password: 'secret' }).send({ from: 'Sam <sam@get.example>', to: 'd@n.example', subject: 'Hi', text: 'Body', headers: { 'List-Unsubscribe': '<mailto:sam@get.example?subject=unsubscribe>' }, inReplyTo: '<a@b>' });
    expect(res.messageId).toMatch(/^</);
    expect(user).toBe('sam');
    const m = await simpleParser(raw);
    expect(m.subject).toBe('Hi');
    expect(m.text?.trim()).toBe('Body');
    expect(m.inReplyTo).toBe('<a@b>');
    expect(raw).toMatch(/List-Unsubscribe: <mailto:sam@get\.example/);
  });
});
