import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { stdin, stdout } from 'node:process';
import { loadConfig, ADMIN_ID } from './config.js';
import { createClient, readSession, saveSession, acquireLock } from './telegram.js';
import { UserError, friendlyError } from './errors.js';

async function main() {
  process.umask(0o077);
  const config = loadConfig();
  const printSession = process.argv.includes('--print-session');
  if (!stdin.isTTY) throw new UserError('ورود اولیه به ترمینال تعاملی نیاز دارد. روی رایانهٔ مطمئن npm run login را اجرا کنید (برای میزبان بدون ترمینال از --print-session استفاده کنید) و فقط رشتهٔ نشست را امن منتقل کنید.');
  const release = await acquireLock(config.sessionPath);
  let client;
  let rl;
  try {
    let muted = false;
    const output = new Writable({ write(chunk, encoding, callback) { if (!muted) stdout.write(chunk, encoding); callback(); } });
    rl = createInterface({ input: stdin, output, terminal: true });
    const ask = async (label, secret = false) => {
      stdout.write(label);
      muted = secret;
      try { return (await rl.question('')).trim(); }
      finally { muted = false; if (secret) stdout.write('\n'); }
    };
    client = createClient(config, config.session || readSession(config.sessionPath));
    await client.start({
      phoneNumber: async () => config.phone || await ask('Phone (+country code): '),
      phoneCode: async () => await ask('Telegram login code (hidden): ', true),
      password: async () => await ask('Two-step verification password (hidden): ', true),
      onError: error => { console.error(friendlyError(error)); return true; }
    });
    if (!await client.checkAuthorization()) throw new UserError('ورود موفق نبود؛ دوباره تلاش کنید.');
    const me = await client.getMe();
    if (me.id.toString() === ADMIN_ID) throw new UserError('اکانت یوزربات باید از اکانت ادمین جدا باشد. با شمارهٔ دیگری وارد شوید.');
    const value = client.session.save();
    try { saveSession(client, config.sessionPath); }
    catch (error) { console.error(`هشدار: ذخیرهٔ فایل نشست انجام نشد (${error.code || 'ERROR'})؛ فقط رشتهٔ چاپ‌شده را نگه دارید.`); }
    if (printSession) {
      stdout.write('\n=== TELEGRAM_SESSION ===\n');
      stdout.write(`${value}\n`);
      stdout.write('========================\n');
      stdout.write('این رشته مثل رمز عبور است: آن را در متغیر محیطی محرمانهٔ میزبان (TELEGRAM_SESSION) بگذارید، در Git/چت/لاگ نگذارید.\n');
    } else {
      console.log('نشست به‌صورت امن در DATA_DIR ذخیره شد؛ اکنون npm start را اجرا کنید. کد و رمز ذخیره نشده‌اند.');
      console.log('برای میزبانی که ترمینال یا دیسک دائمی ندارد: npm run login -- --print-session و سپس مقدار TELEGRAM_SESSION را در پنل میزبان تنظیم کنید.');
    }
  } finally {
    rl?.close();
    await client?.destroy();
    await release();
  }
}
main().catch(error => { console.error(error instanceof UserError ? error.message : friendlyError(error)); process.exitCode = 1; });
