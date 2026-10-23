import { Api, utils } from 'teleproto';
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
  // Prefer the explicit MTProto identity (anonymous admins / send-as-channel).
  // Never infer the hidden human identity from a signature or forwarded header.
  let sender = message.fromId ? utils.getPeerId(message.fromId).toString() : message.senderId?.toString();
  // MTProto can omit fromId when the sender is the channel/supergroup itself.
  // Teleproto synthesizes senderId for channel posts, but not for non-post
  // supergroup messages. Only fall back for incoming channel peers with no
  // sender at all: never override an explicit user/channel, use a forwarded
  // identity, or treat an unidentified outgoing/private/basic-chat message as
  // anonymous. The group still needs its own explicit whitelist rule.
  if (!sender && !message.out && message.peerId instanceof Api.PeerChannel) {
    sender = utils.getPeerId(message.peerId).toString();
  }
  if (!sender) return null;
  const rule = store.ruleFor(sender);
  if (!rule || (message.fwdFrom && !rule.forwards)) return null;
  return { source, destination, rule, includeReply: !!rule.replies };
}
