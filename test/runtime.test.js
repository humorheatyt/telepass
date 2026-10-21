import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient, saveSession, readSession, acquireLock } from '../src/telegram.js';
import { loadConfig } from '../src/config.js';
import { errorCode } from '../src/errors.js';

test('invalid configuration fails locally before any Telegram request', () => {
  assert.throws(() => loadConfig({}), /TELEGRAM_API_ID/);
});

test('session is atomic, private and no secret is included in error logs', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'telepass-session-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.txt');
  saveSession({ session: { save: () => 'sensitive-value' } }, file);
  assert.equal(readSession(file), 'sensitive-value');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(errorCode(new Error('sensitive-value')), 'REQUEST_FAILED');
});

test('single instance lock prevents concurrent login/runtime and can be released', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'telepass-lock-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.txt'); writeFileSync(file, 'test');
  const release = await acquireLock(file);
  try { await assert.rejects(acquireLock(file), /پردازش دیگر/); }
  finally { await release(); }
  const nextRelease = await acquireLock(file); await nextRelease();
});

test('MTProto client can be initialized offline with bounded entity caches', async () => {
  const client = createClient({ apiId: 123, apiHash: 'a'.repeat(32) }, '');
  assert.equal(!!client.connected, false);
  for (let i = 0; i < 1600; i++) client.session._entities.set(String(i), [i]);
  client.session.processEntities({});
  assert.equal(client.session._entities.size, 1500);
  await client.destroy();
});

test('saving an unchanged session repairs insecure permissions after upload', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'telepass-session-mode-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.txt');
  writeFileSync(file, 'same-session', { mode: 0o644 });
  saveSession({ session: { save: () => 'same-session' } }, file);
  assert.equal(readSession(file), 'same-session');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
