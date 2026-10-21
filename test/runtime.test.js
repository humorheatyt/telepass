import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient, saveSession, readSession, acquireLock, resolveSession } from '../src/telegram.js';
import { StringSession } from 'teleproto/sessions';
import { AuthKey } from 'teleproto/crypto/AuthKey';

async function sessionString(dc = 2) {
  const key = new AuthKey();
  await key.setKey(Buffer.alloc(256, 7));
  const session = new StringSession();
  session._authKey = key; session._dcId = dc; session._serverAddress = '149.154.167.51'; session._port = 443;
  return session.save();
}
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

test('environment values from panels (quotes, spaces, line breaks) are cleaned', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'telepass-env-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = loadConfig({
    TELEGRAM_API_ID: ' 12345 ',
    TELEGRAM_API_HASH: `"${'a'.repeat(32)}"\n`,
    DATA_DIR: `"${dir}"`,
    PORT: '8080'
  });
  assert.equal(config.apiId, 12345);
  assert.equal(config.apiHash, 'a'.repeat(32));
  assert.equal(config.dataDir, dir);
  assert.equal(config.port, 8080);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('session can come from TELEGRAM_SESSION so hosts without shell or disk work', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'telepass-env-session-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const value = await sessionString();
  const config = loadConfig({ TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: 'b'.repeat(32), DATA_DIR: dir, TELEGRAM_SESSION: `${value.slice(0, 20)}\n${value.slice(20)} ` });
  assert.equal(await resolveSession(config), value);
  writeFileSync(path.join(dir, 'session.txt'), `${value}\n`);
  assert.equal(await resolveSession(config), value);
});

test('a missing, corrupt or conflicting session fails with an actionable message', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'telepass-env-missing-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = { TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: 'b'.repeat(32), DATA_DIR: dir };
  await assert.rejects(resolveSession(loadConfig(base)), /نشست تلگرام موجود نیست/);
  await assert.rejects(resolveSession(loadConfig({ ...base, TELEGRAM_SESSION: '1truncated' })), /TELEGRAM_SESSION معتبر نیست/);
  const value = await sessionString();
  writeFileSync(path.join(dir, 'session.txt'), await sessionString(9));
  await assert.rejects(resolveSession(loadConfig({ ...base, TELEGRAM_SESSION: value })), /یکسان نیست/);
});
