import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HARD_DAILY_LIMIT = 50; // per mailbox, whatever the config says

export type Config = {
  website: string; language: 'en-US' | 'en-GB';
  sender: { name: string; company: string; email: string; postal_address: string };
  smtp: { host: string; port: number; secure: boolean; user: string };
  imap: { host: string; port: number; secure: boolean; user: string };
  limits: { start_per_day: number; add_per_day: number; max_per_day: number; min_gap_minutes: number; send_hours: [number, number]; weekdays: number[]; timezone: string; bounce_stop_rate: number };
  warmup_start: string | null;
  do_not_contact: string[];
  model: { provider: 'anthropic' | 'claude-cli'; name: string; max_calls_per_day: number };
  booking_url: string;
  contacts: { max_lookups_per_day: number };
  loop_minutes: number;
  cloud_url: string;
};

export const DEFAULTS: Config = {
  website: '', language: 'en-US',
  sender: { name: '', company: '', email: '', postal_address: '' },
  smtp: { host: '', port: 465, secure: true, user: '' },
  imap: { host: '', port: 993, secure: true, user: '' },
  limits: { start_per_day: 5, add_per_day: 3, max_per_day: 30, min_gap_minutes: 4, send_hours: [9, 17], weekdays: [1, 2, 3, 4, 5], timezone: 'America/New_York', bounce_stop_rate: 0.03 },
  warmup_start: null,
  do_not_contact: [],
  model: { provider: 'anthropic', name: 'claude-opus-5-5', max_calls_per_day: 0 }, // 0: no limit. Your key, your call
  booking_url: '',
  contacts: { max_lookups_per_day: 0 }, // 0: no limit
  loop_minutes: 5,
  cloud_url: 'https://api.outlevo.com',
};

export const homeDir = (env = process.env) => env.OUTLEVO_HOME || join(process.cwd(), '.outlevo');

const merge = <T>(base: T, over: any): T => {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out: any = { ...base };
  for (const k of Object.keys(over ?? {})) out[k] = k in (base as any) ? merge((base as any)[k], over[k]) : over[k];
  return out;
};

export function loadConfig(home = homeDir()): Config {
  const p = join(home, 'config.json');
  return merge(DEFAULTS, existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {});
}

export function saveConfig(c: Config, home = homeDir()) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'config.json'), JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
}

/** `sender.email` style paths; numbers and booleans are parsed so the file keeps its types. */
export function setPath(c: Config, path: string, value: string): Config {
  const keys = path.split('.');
  let at: any = c; let known: any = DEFAULTS;
  for (const k of keys.slice(0, -1)) {
    if (typeof at[k] !== 'object' || at[k] === null) throw new Error(`Unknown setting: ${path}`);
    at = at[k]; known = known[k];
  }
  const last = keys.at(-1)!;
  if (!(last in known)) throw new Error(`Unknown setting: ${path}`);
  const kind = typeof known[last];
  let parsed: unknown;
  if (Array.isArray(known[last])) {
    try { parsed = JSON.parse(value); } catch { throw new Error(`${path} must be a list, like ["a.com"] or [9,17]`); }
    if (!Array.isArray(parsed)) throw new Error(`${path} must be a list, like ["a.com"] or [9,17]`);
  } else if (kind === 'number') {
    parsed = Number(value);
    if (value.trim() === '' || !Number.isFinite(parsed)) throw new Error(`${path} must be a number`);
  } else if (kind === 'boolean') {
    if (value !== 'true' && value !== 'false') throw new Error(`${path} must be true or false`);
    parsed = value === 'true';
  } else parsed = value;
  at[last] = parsed;
  const wrong = settingsProblems(c);
  if (wrong.length) throw new Error(wrong.join('; '));
  return c;
}

/** Settings a limit depends on. A bad one must never mean "no limit": sending refuses until it is fixed. */
export function settingsProblems(c: Config): string[] {
  const out: string[] = []; const l = c.limits;
  const count = (v: unknown, name: string, min: number) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min) out.push(`limits.${name} must be a number of at least ${min}`); };
  count(l.start_per_day, 'start_per_day', 1); count(l.add_per_day, 'add_per_day', 0); count(l.max_per_day, 'max_per_day', 1); count(l.min_gap_minutes, 'min_gap_minutes', 0);
  if (typeof l.bounce_stop_rate !== 'number' || !(l.bounce_stop_rate >= 0 && l.bounce_stop_rate <= 1)) out.push('limits.bounce_stop_rate must be between 0 and 1');
  if (!Array.isArray(l.send_hours) || l.send_hours.length !== 2 || !l.send_hours.every((h) => Number.isInteger(h) && h >= 0 && h <= 24) || l.send_hours[0] >= l.send_hours[1]) out.push('limits.send_hours must be two hours, like [9,17]');
  if (!Array.isArray(l.weekdays) || !l.weekdays.length || !l.weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) out.push('limits.weekdays must be days from 0 (Sunday) to 6, like [1,2,3,4,5]');
  try { new Intl.DateTimeFormat('en-US', { timeZone: l.timezone }); } catch { out.push(`limits.timezone is not a time zone: ${l.timezone}`); }
  if (c.warmup_start !== null && (typeof c.warmup_start !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(c.warmup_start) || Number.isNaN(new Date(c.warmup_start).getTime()) || new Date(`${c.warmup_start.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== c.warmup_start.slice(0, 10))) out.push('warmup_start must be a date like 2026-11-01');
  return out;
}

// Secrets live in the environment or in a 0600 file next to the database, never in config.json.
type Secrets = { smtp_password?: string; imap_password?: string; outlevo_key?: string; hunter_key?: string };
export function loadSecrets(home = homeDir(), env = process.env): Secrets {
  const p = join(home, 'secrets.json');
  const file: Secrets = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  return {
    smtp_password: env.OUTLEVO_SMTP_PASSWORD || file.smtp_password,
    imap_password: env.OUTLEVO_IMAP_PASSWORD || env.OUTLEVO_SMTP_PASSWORD || file.imap_password || file.smtp_password,
    outlevo_key: env.OUTLEVO_KEY || file.outlevo_key,
    hunter_key: env.HUNTER_API_KEY || file.hunter_key,
  };
}
export function saveSecret(key: keyof Secrets, value: string, home = homeDir()) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const p = join(home, 'secrets.json');
  const file: Secrets = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  writeFileSync(p, JSON.stringify({ ...file, [key]: value }, null, 2), { mode: 0o600 });
  chmodSync(p, 0o600);
}
