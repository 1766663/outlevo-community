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
  model: { provider: 'anthropic', name: 'claude-opus-5-5', max_calls_per_day: 200 },
  booking_url: '',
  contacts: { max_lookups_per_day: 25 },
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
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify(c, null, 2) + '\n');
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
  at[last] = Array.isArray(known[last]) ? JSON.parse(value)
    : kind === 'number' ? Number(value) : kind === 'boolean' ? value === 'true' : value;
  return c;
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
  mkdirSync(home, { recursive: true });
  const p = join(home, 'secrets.json');
  const file: Secrets = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  writeFileSync(p, JSON.stringify({ ...file, [key]: value }, null, 2), { mode: 0o600 });
  chmodSync(p, 0o600);
}
