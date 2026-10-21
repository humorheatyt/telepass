import 'dotenv/config';
import { UserError } from './errors.js';
import path from 'node:path';
import { mkdirSync, chmodSync } from 'node:fs';

export const ADMIN_ID = '8583719429';

function clean(value) {
  return String(value ?? '').trim().replace(/^['"]+|['"]+$/g, '');
}

function ensureDataDir(dir) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new UserError(`پوشهٔ DATA_DIR ساخته نشد (${error.code || 'ERROR'}): ${dir} — میزبان باید اجازهٔ نوشتن بدهد.`);
  }
  try {
    chmodSync(dir, 0o700);
  } catch (error) {
    // Read-only or root-owned mounts on some hosts still work if the dir is already private.
    if (!['EPERM', 'EACCES', 'EROFS'].includes(error.code)) throw error;
  }
}

export function loadConfig(env = process.env) {
  const apiId = Number(clean(env.TELEGRAM_API_ID));
  const apiHash = clean(env.TELEGRAM_API_HASH);
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !/^[a-f\d]{32}$/i.test(apiHash)) {
    throw new UserError('TELEGRAM_API_ID و TELEGRAM_API_HASH معتبر نیستند؛ آن‌ها را در متغیرهای محیطی (Environment / Secrets) همین سرویس تنظیم کنید، نه فقط در فایل .env محلی.');
  }
  const dataDir = path.resolve(clean(env.DATA_DIR) || './data');
  ensureDataDir(dataDir);
  const port = env.PORT ? Number(env.PORT) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new UserError('PORT نامعتبر است.');
  // Optional string session for hosts without a shell or persistent disk (Botkeep, Faable, Render, ...).
  // Created locally with: npm run login -- --print-session
  const session = clean(env.TELEGRAM_SESSION).replace(/\s+/g, '');
  return {
    apiId, apiHash, dataDir,
    sessionPath: path.join(dataDir, 'session.txt'),
    dbPath: path.join(dataDir, 'telepass.sqlite'),
    phone: clean(env.TELEGRAM_PHONE) || undefined,
    port, session: session || undefined
  };
}
