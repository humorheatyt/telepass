import 'dotenv/config';
import { UserError } from './errors.js';
import path from 'node:path';
import { mkdirSync, chmodSync } from 'node:fs';

export const ADMIN_ID = '8583719429';
export function loadConfig(env = process.env) {
  const apiId = Number(env.TELEGRAM_API_ID);
  const apiHash = env.TELEGRAM_API_HASH?.trim();
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !/^[a-f\d]{32}$/i.test(apiHash || '')) {
    throw new UserError('TELEGRAM_API_ID و TELEGRAM_API_HASH معتبر را در .env قرار دهید.');
  }
  const dataDir = path.resolve(env.DATA_DIR || './data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const port = env.PORT ? Number(env.PORT) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new UserError('PORT نامعتبر است.');
  return { apiId, apiHash, dataDir, sessionPath: path.join(dataDir, 'session.txt'),
    dbPath: path.join(dataDir, 'telepass.sqlite'), phone: env.TELEGRAM_PHONE?.trim(), port };
}
