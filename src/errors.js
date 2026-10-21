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
    USERNAME_NOT_OCCUPIED: 'This username does not exist.',
    USERNAME_INVALID: 'Invalid username.',
    INVITE_HASH_EXPIRED: 'The invite link has expired.',
    INVITE_HASH_INVALID: 'Invalid invite link.',
    CHANNEL_PRIVATE: 'The account cannot access this channel or group.',
    CHAT_ADMIN_REQUIRED: 'Administrator privileges are required.',
    CHAT_WRITE_FORBIDDEN: 'The account cannot send messages to the destination.',
    USER_PRIVACY_RESTRICTED: 'Privacy settings prevent this operation.',
    INVITE_REQUEST_SENT: 'Join request sent. Add the source again after approval.'
  };
  if (Number(error?.seconds) > 0) return `Telegram applied a time limit. Try again in ${error.seconds} seconds.`;
  return messages[code] || `Operation failed (${code}). Check access and the reference.`;
}
export class UserError extends Error {}
