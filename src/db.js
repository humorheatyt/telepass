import { UserError } from './errors.js';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { chmodSync } from 'node:fs';

export const MAX_PENDING = 5000;
export class Store {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`
      PRAGMA auto_vacuum=INCREMENTAL;
      PRAGMA max_page_count=16384;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      PRAGMA cache_size=-2048;
      PRAGMA journal_size_limit=2097152;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS peers (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, raw_id TEXT NOT NULL, access_hash TEXT,
        name TEXT NOT NULL, username TEXT, reference TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sources (peer_id TEXT PRIMARY KEY REFERENCES peers(id));
      CREATE TABLE IF NOT EXISTS rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT, peer_id TEXT NOT NULL UNIQUE REFERENCES peers(id),
        forwards INTEGER NOT NULL DEFAULT 1 CHECK(forwards IN (0,1)),
        replies INTEGER NOT NULL DEFAULT 0 CHECK(replies IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, message_id INTEGER NOT NULL,
        destination TEXT NOT NULL, rule_id INTEGER NOT NULL, random_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, finished_at INTEGER,
        error TEXT, UNIQUE(source, message_id, destination)
      );
      CREATE INDEX IF NOT EXISTS jobs_status_id ON jobs(status, id);
      PRAGMA user_version=1;
    `);
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(key, fallback = null) { return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? fallback; }
  set(key, value) { this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }
  peer(id) { return this.db.prepare('SELECT * FROM peers WHERE id=?').get(String(id)); }
  savePeer(p) {
    this.db.prepare(`INSERT INTO peers VALUES (:id,:kind,:raw_id,:access_hash,:name,:username,:reference)
      ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, raw_id=excluded.raw_id,
      access_hash=COALESCE(excluded.access_hash,peers.access_hash),name=excluded.name,
      username=excluded.username,reference=excluded.reference`).run(p);
    return this.peer(p.id);
  }
  sources() { return this.db.prepare('SELECT p.* FROM sources s JOIN peers p ON p.id=s.peer_id ORDER BY p.name').all(); }
  hasSource(id) { return !!this.db.prepare('SELECT 1 FROM sources WHERE peer_id=?').get(String(id)); }
  addSource(id) {
    const p = this.peer(id);
    if (!p || p.kind === 'user') throw new UserError('A source must be a group or channel.');
    if (this.get('destination') === id) throw new UserError('A source and destination cannot be the same.');
    this.db.prepare('INSERT OR IGNORE INTO sources VALUES (?)').run(id);
  }
  removeSource(id) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM sources WHERE peer_id=?').run(id);
      this.db.prepare("DELETE FROM jobs WHERE source=? AND status='pending'").run(id);
    });
  }
  rules() { return this.db.prepare('SELECT r.*,p.kind,p.name,p.username,p.reference FROM rules r JOIN peers p ON p.id=r.peer_id ORDER BY r.id').all(); }
  ruleFor(id) { return this.db.prepare('SELECT r.*,p.kind FROM rules r JOIN peers p ON p.id=r.peer_id WHERE peer_id=?').get(String(id)); }
  rule(id) { return this.db.prepare('SELECT r.*,p.kind FROM rules r JOIN peers p ON p.id=r.peer_id WHERE r.id=?').get(id); }
  addRule(peerId) {
    const p = this.peer(peerId);
    if (!p || !['user', 'channel', 'supergroup', 'chat'].includes(p.kind)) throw new UserError('Whitelist entries must be users, groups, or channels.');
    this.db.prepare('INSERT OR IGNORE INTO rules(peer_id) VALUES (?)').run(peerId);
    return this.ruleFor(peerId);
  }
  removeRule(id) {
    if (!this.rule(id)) throw new UserError('Whitelist rule not found.');
    this.transaction(() => {
      this.db.prepare('DELETE FROM rules WHERE id=?').run(id);
      this.db.prepare("DELETE FROM jobs WHERE rule_id=? AND status='pending'").run(id);
    });
  }
  toggle(id, field, value) {
    if (!['forwards', 'replies'].includes(field)) throw new UserError('Invalid setting.');
    const rule = this.rule(id);
    if (!rule) throw new UserError('Whitelist rule not found.');
    this.db.prepare(`UPDATE rules SET ${field}=? WHERE id=?`).run(value ? 1 : 0, id);
  }
  toggleAll(field, value) {
    if (!['forwards', 'replies'].includes(field)) throw new UserError('Invalid setting.');
    return this.db.prepare(`UPDATE rules SET ${field}=?`).run(value ? 1 : 0).changes;
  }
  setDestination(id) {
    if (this.hasSource(id)) throw new UserError('The destination cannot be a source; remove it from the source list first.');
    if (this.pendingCount() && this.get('destination') !== id) throw new UserError('Drain the queue first, or clear it with /queue clear confirm.');
    this.set('destination', id);
  }
  pendingCount() { return this.db.prepare("SELECT count(*) AS n FROM jobs WHERE status='pending'").get().n; }
  enqueue(source, ids, destination, ruleId, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.db.prepare(`INSERT OR IGNORE INTO jobs
        (source,message_id,destination,rule_id,random_id,created_at) VALUES (?,?,?,?,?,?)`);
      let count = this.pendingCount();
      let added = 0;
      for (const id of [...new Set(ids)]) {
        if (this.db.prepare('SELECT 1 FROM jobs WHERE source=? AND message_id=? AND destination=?').get(source, id, destination)) continue;
        if (count >= MAX_PENDING) throw Object.assign(new UserError('QUEUE_FULL'), { code: 'QUEUE_FULL' });
        insert.run(source, id, destination, ruleId, randomBytes(8).readBigInt64LE().toString(), now);
        count++; added++;
      }
      this.db.exec('COMMIT');
      return added;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (error.code === 'QUEUE_FULL') {
        this.set('overflow_events', Number(this.get('overflow_events', '0')) + 1);
        this.set('last_overflow', now);
      }
      throw error;
    }
  }
  nextJob() { return this.db.prepare("SELECT * FROM jobs WHERE status='pending' ORDER BY id LIMIT 1").get(); }
  done(id, now = Date.now()) { this.db.prepare("UPDATE jobs SET status='done', finished_at=?,error=NULL WHERE id=?").run(now, id); }
  retry(id, nextAt, error, increment = true) {
    this.db.prepare('UPDATE jobs SET next_at=?,error=?,attempts=attempts+? WHERE id=?').run(nextAt, error, increment ? 1 : 0, id);
  }
  fail(id, error) { this.db.prepare("UPDATE jobs SET status='failed',error=?,finished_at=? WHERE id=?").run(error, Date.now(), id); }
  clearPending() { return this.db.prepare("DELETE FROM jobs WHERE status='pending'").run().changes; }
  errors() { return this.db.prepare("SELECT id,source,message_id,error FROM jobs WHERE status='failed' ORDER BY id DESC LIMIT 10").all(); }
  stats() { return this.db.prepare('SELECT status,count(*) AS n FROM jobs GROUP BY status').all(); }
  prune(now = Date.now()) {
    this.db.prepare("DELETE FROM jobs WHERE status!='pending' AND finished_at<?").run(now - 7 * 86400000);
    this.db.exec(`DELETE FROM jobs WHERE status!='pending' AND id NOT IN
      (SELECT id FROM jobs WHERE status!='pending' ORDER BY id DESC LIMIT 20000);
      DELETE FROM peers WHERE id NOT IN (SELECT peer_id FROM sources)
        AND id NOT IN (SELECT peer_id FROM rules)
        AND id NOT IN (SELECT source FROM jobs WHERE status='pending')
        AND id NOT IN (SELECT destination FROM jobs WHERE status='pending')
        AND id NOT IN (SELECT value FROM settings WHERE key IN ('destination','account_id'))
        AND rowid NOT IN (SELECT rowid FROM peers ORDER BY rowid DESC LIMIT 1500);
      PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum(200); PRAGMA optimize;`);
  }
  close() { this.db.close(); }
}
