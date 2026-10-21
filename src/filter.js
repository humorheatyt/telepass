import { ADMIN_ID } from './config.js';

export function isAdminMessage(message) {
  return !message.out && !!message.isPrivate && String(message.senderId) === ADMIN_ID;
}

// Deliberately match the visible sender, NOT fwdFrom.fromId: forwarding a
// whitelisted user's post must not let an unrelated sender impersonate them.
export function matchMessage(store, message) {
  if (store.get('paused') === '1') return null;
  const source = String(message.chatId);
  const destination = store.get('destination');
  if (!destination || source === destination || !store.hasSource(source)) return null;
  if (!Number.isSafeInteger(message.id) || message.id <= 0 || message.action) return null;
  const sender = message.senderId?.toString();
  if (!sender) return null;
  const rule = store.ruleFor(sender);
  if (!rule || (message.fwdFrom && !rule.forwards)) return null;
  return { source, destination, rule, includeReply: rule.kind === 'user' && !!rule.replies };
}
