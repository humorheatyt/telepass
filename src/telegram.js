import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { Logger } from 'teleproto/extensions';
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import lockfile from 'proper-lockfile';
import { UserError } from './errors.js';

// StringSession's entity rows would otherwise grow for every sender seen.
class BoundedSession extends StringSession {
  processEntities(value) {
    super.processEntities(value);
    while (this._entities.size > 1500) this._entities.delete(this._entities.keys().next().value);
  }
}
export function readSession(file) {
  try { return readFileSync(file, 'utf8').trim(); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
export function saveSession(client, file) {
  const value = client.session.save();
  if (!value) return;
  if (value === readSession(file)) {
    chmodSync(file, 0o600);
    return;
  }
  writeFileSync(`${file}.tmp`, value, { mode: 0o600 });
  chmodSync(`${file}.tmp`, 0o600);
  renameSync(`${file}.tmp`, file);
}
export function createClient(config, session) {
  const client = new TelegramClient(new BoundedSession(session), config.apiId, config.apiHash, {
    connectionRetries: 5, reconnectRetries: Infinity, retryDelay: 2000,
    autoReconnect: true, requestRetries: 2, floodSleepThreshold: 0,
    baseLogger: new Logger('none'), entityCache: { max: 1500 }, deviceModel: 'Telepass Server', appVersion: '1.0.0'
  });
  // Library debug logs may contain requests: keep them disabled.
  client.setLogLevel('none');
  return client;
}
export async function acquireLock(file, onCompromised) {
  try {
    return await lockfile.lock(file, {
      realpath: false, stale: 30000, update: 10000, retries: 0,
      onCompromised: onCompromised || (() => process.exit(1))
    });
  } catch (error) {
    if (error.code === 'ELOCKED') throw new UserError('یک پردازش دیگر از همین DATA_DIR استفاده می‌کند؛ هم‌زمان فقط یک نمونه اجرا کنید (پس از کرش ۳۰ ثانیه صبر کنید).');
    throw error;
  }
}
