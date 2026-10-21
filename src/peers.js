import { Api, utils } from 'teleproto';
import bigInt from 'big-integer';
import { UserError } from './errors.js';

export function parseReference(input) {
  const text = String(input || '').trim();
  if (!text || /\s/.test(text)) throw new UserError('Enter an ID or link without spaces.');
  if (/^-?\d+$/.test(text)) return { type: 'id', value: bigInt(text).toString() };
  if (/^\+[1-9]\d{7,14}$/.test(text)) return { type: 'phone', value: text };
  if (/^@[a-z][a-z0-9_]{3,31}$/i.test(text)) return { type: 'username', value: text.slice(1) };
  let url;
  try { url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`); }
  catch { throw new UserError('Invalid reference format.'); }
  if (!['https:', 'http:'].includes(url.protocol) || !['t.me', 'telegram.me', 'www.t.me'].includes(url.hostname) || url.port || url.username || url.password) {
    // Bare usernames are also accepted, but never arbitrary URLs.
    if (/^[a-z][a-z0-9_]{3,31}$/i.test(text)) return { type: 'username', value: text };
    throw new UserError('Only t.me links, usernames, or numeric IDs are accepted.');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'joinchat' && /^[\w-]+$/.test(parts[1] || '')) return { type: 'invite', value: parts[1] };
  if (parts[0]?.startsWith('+') && /^[\w-]+$/.test(parts[0].slice(1))) return { type: 'invite', value: parts[0].slice(1) };
  if (parts[0] === 'c' && /^\d+$/.test(parts[1] || '')) return { type: 'id', value: `-100${parts[1]}` };
  const name = parts[0] === 's' ? parts[1] : parts[0];
  if (/^[a-z][a-z0-9_]{3,31}$/i.test(name || '')) return { type: 'username', value: name };
  throw new UserError('Unrecognized Telegram link.');
}

export function peerRecord(entity, reference = '') {
  let kind;
  if (entity instanceof Api.User) kind = 'user';
  else if (entity instanceof Api.Channel) kind = entity.megagroup || entity.gigagroup ? 'supergroup' : 'channel';
  else if (entity instanceof Api.Chat) kind = 'chat';
  else throw new UserError('This entity cannot be used.');
  return {
    id: utils.getPeerId(entity).toString(), kind, raw_id: entity.id.toString(),
    access_hash: entity.accessHash?.toString() || null,
    name: entity.title || [entity.firstName, entity.lastName].filter(Boolean).join(' ') || entity.username || entity.id.toString(),
    username: entity.username || null,
    reference: reference || (entity.username ? `@${entity.username}` : utils.getPeerId(entity).toString())
  };
}

export function inputPeer(peer) {
  if (!peer) throw new UserError('Reference is not saved; add it again using a username or link.');
  if (peer.kind === 'chat') return new Api.InputPeerChat({ chatId: bigInt(peer.raw_id) });
  if (!peer.access_hash) throw new UserError('Access hash is missing; use /sync or a username.');
  return peer.kind === 'user'
    ? new Api.InputPeerUser({ userId: bigInt(peer.raw_id), accessHash: bigInt(peer.access_hash) })
    : new Api.InputPeerChannel({ channelId: bigInt(peer.raw_id), accessHash: bigInt(peer.access_hash) });
}

export class PeerService {
  constructor(client, store) { this.client = client; this.store = store; }
  async resolve(reference, { join = false } = {}) {
    const parsed = parseReference(reference);
    let entity;
    if (parsed.type === 'invite') {
      const result = await this.client.invoke(new Api.messages.CheckChatInvite({ hash: parsed.value }));
      if (result instanceof Api.ChatInviteAlready) entity = result.chat;
      else if (join) {
        const updates = await this.client.invoke(new Api.messages.ImportChatInvite({ hash: parsed.value }));
        entity = updates.chats?.[0];
        if (!entity) throw new UserError('Membership is not confirmed yet; try again after it is approved.');
      } else throw new UserError('Join first with /join LINK; adding a link does not join the chat.');
    } else {
      const cached = parsed.type === 'id' ? this.store.peer(parsed.value) : null;
      try {
        entity = await this.client.getEntity(cached ? inputPeer(cached) : parsed.type === 'id' ? bigInt(parsed.value) : parsed.value);
      } catch (error) {
        if (parsed.type === 'id' && !error.errorMessage) throw new UserError('This ID is not known to the account. Run /sync or use a username/link.');
        throw error;
      }
      if (join && entity instanceof Api.Channel) {
        const result = await this.client.invoke(new Api.channels.JoinChannel({ channel: utils.getInputChannel(entity) }));
        entity = result.chats?.find(c => c.id?.equals(entity.id)) || entity;
      } else if (join) throw new UserError('An invite link is required to join a private group.');
    }
    const peer = this.store.savePeer(peerRecord(entity, reference));
    return { peer, entity };
  }
  async sync() {
    let count = 0;
    // Bound both RAM and RPC work; no message/media is stored.
    for await (const dialog of this.client.iterDialogs({ limit: 200 })) {
      try {
        const record = peerRecord(dialog.entity);
        const old = this.store.peer(record.id);
        this.store.savePeer({ ...record, reference: old?.reference || record.reference });
        count++;
      } catch (error) { if (!(error instanceof UserError)) throw error; }
    }
    return count;
  }
}

export function describe(peer) {
  const clean = value => String(value).replace(/[\r\n\u202a-\u202e\u2066-\u2069]/g, ' ');
  return `${clean(peer.name)}${peer.username ? ` | @${clean(peer.username)}` : ''}\nID: ${peer.peer_id || peer.id}\nReference: ${clean(peer.reference)}`;
}
