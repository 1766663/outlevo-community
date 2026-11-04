import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
create table if not exists meta (key text primary key, value text);
create table if not exists product (id integer primary key check (id = 1), url text, summary text, updated_at text);
create table if not exists product_facts (id integer primary key, text text not null, quote text not null, source_url text not null, fetched_at text not null);
create table if not exists icp (id integer primary key check (id = 1), body text not null, source text not null, updated_at text not null);
create table if not exists companies (
  id integer primary key, domain text not null unique, name text, source text not null, status text not null default 'new',
  score integer, reasons text, error text, cloud_id text, created_at text not null, researched_at text);
create table if not exists facts (
  id integer primary key, company_id integer not null references companies(id) on delete cascade,
  kind text not null, text text not null, quote text not null, source_url text not null, published_at text, fetched_at text not null);
create table if not exists contacts (
  id integer primary key, company_id integer not null references companies(id) on delete cascade,
  first_name text not null, last_name text, title text, email text not null unique,
  email_source text not null check (email_source in ('imported','published','guess','verified')),
  status text not null default 'active', cloud_id text, created_at text not null);
create table if not exists drafts (
  id integer primary key, contact_id integer not null references contacts(id) on delete cascade, step integer not null,
  subject text not null, body text not null, claims text not null, angle text, delay_days integer not null default 0,
  lint text not null, status text not null check (status in ('pending','approved','rejected','blocked','sent','cancelled')),
  created_at text not null, approved_at text, sent_at text, message_id text, unique (contact_id, step));
create table if not exists replies (
  id integer primary key, contact_id integer references contacts(id) on delete set null, message_id text unique, from_addr text not null,
  subject text, text text, class text not null, reason text, received_at text not null,
  suggested text, suggested_status text not null default 'none' check (suggested_status in ('none','pending','sent','dismissed')));
create table if not exists meetings (
  id integer primary key, contact_id integer not null references contacts(id) on delete cascade, source text not null, title text,
  message_id text unique, status text not null default 'booked' check (status in ('booked','cancelled')), booked_at text not null);
create table if not exists suppression (value text primary key, reason text not null, created_at text not null);
create table if not exists events (id integer primary key, at text not null, kind text not null, data text);
create table if not exists usage (day text not null, kind text not null, count integer not null default 0, primary key (day, kind));
`;

export type Db = DatabaseSync;

export function openDb(home: string): Db {
  mkdirSync(home, { recursive: true });
  return openPath(join(home, 'outlevo.db'));
}

export function openPath(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export const all = <T = any>(db: Db, sql: string, ...args: any[]) => db.prepare(sql).all(...args) as T[];
export const one = <T = any>(db: Db, sql: string, ...args: any[]) => db.prepare(sql).get(...args) as T | undefined;
export const run = (db: Db, sql: string, ...args: any[]) => db.prepare(sql).run(...args);

export function getMeta(db: Db, key: string) { return one<{ value: string }>(db, 'select value from meta where key = ?', key)?.value ?? null; }
export function setMeta(db: Db, key: string, value: string | null) {
  if (value === null) run(db, 'delete from meta where key = ?', key);
  else run(db, 'insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value', key, value);
}

/** Everything that changes the outside world or spends money leaves a line here. */
export function logEvent(db: Db, at: Date, kind: string, data: unknown = null) {
  run(db, 'insert into events (at, kind, data) values (?, ?, ?)', at.toISOString(), kind, data === null ? null : JSON.stringify(data));
}
