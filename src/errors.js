// Do not print RPC request objects: they can contain auth data or message text.
export function errorCode(error) {
  const code = error?.errorMessage || error?.code;
  return typeof code === 'string' && /^[A-Z][A-Z_0-9]{1,100}$/.test(code) ? code : 'REQUEST_FAILED';
}
export function logError(context, error) {
  console.error(JSON.stringify({ time: new Date().toISOString(), context, error: errorCode(error) }));
}
export function friendlyError(error) {
  const code = errorCode(error);
  const messages = {
    USERNAME_NOT_OCCUPIED: 'این یوزرنیم وجود ندارد.',
    USERNAME_INVALID: 'یوزرنیم نامعتبر است.',
    INVITE_HASH_EXPIRED: 'لینک دعوت منقضی است.',
    INVITE_HASH_INVALID: 'لینک دعوت نامعتبر است.',
    CHANNEL_PRIVATE: 'اکانت به این کانال یا گروه دسترسی ندارد.',
    CHAT_ADMIN_REQUIRED: 'دسترسی ادمین لازم است.',
    CHAT_WRITE_FORBIDDEN: 'اجازهٔ ارسال در مقصد وجود ندارد.',
    USER_PRIVACY_RESTRICTED: 'تنظیمات حریم خصوصی مانع این عملیات است.',
    INVITE_REQUEST_SENT: 'درخواست عضویت ارسال شد؛ پس از تأیید دوباره مبدأ را اضافه کنید.'
  };
  if (Number(error?.seconds) > 0) return `تلگرام محدودیت زمانی گذاشته؛ ${error.seconds} ثانیه بعد تلاش کنید.`;
  return messages[code] || `عملیات انجام نشد (${code}). دسترسی و شناسه را بررسی کنید.`;
}
export class UserError extends Error {}
