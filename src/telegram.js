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
  try { return readFileSync(file, 'utf8').replace(/\s+/g, ''); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
export async function normalizeSession(value, source = 'نشست') {
  try {
    const session = new BoundedSession(value);
    await session.load();
    const saved = session.save();
    if (!saved) throw new Error('empty session');
    return saved;
  } catch {
    throw new UserError(`${source} معتبر نیست یا کامل کپی نشده؛ آن را دوباره با npm run login -- --print-session بردارید.`);
  }
}
// Session may come from TELEGRAM_SESSION (hosts without shell/disk) or DATA_DIR/session.txt (VPS, Docker).
export async function resolveSession(config) {
  const fromFile = config.sessionPath ? readSession(config.sessionPath) : '';
  const fromEnv = (config.session || '').replace(/\s+/g, '');
  if (fromEnv && fromFile && fromEnv !== fromFile) {
    throw new UserError('TELEGRAM_SESSION با نشست ذخیره‌شده در DATA_DIR یکسان نیست؛ یکی را حذف یا هماهنگ کنید.');
  }
  const value = fromEnv || fromFile;
  if (!value) {
    throw new UserError('نشست تلگرام موجود نیست. یا TELEGRAM_SESSION را در متغیرهای محیطی بگذارید، یا با npm run login فایل session.txt را در DATA_DIR قرار دهید.');
  }
  return await normalizeSession(value, fromEnv ? 'TELEGRAM_SESSION' : 'فایل نشست');
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
