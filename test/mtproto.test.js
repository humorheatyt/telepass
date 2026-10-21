import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api, utils } from 'teleproto';
import { NewMessage } from 'teleproto/events';
import { _dispatchUpdate } from 'teleproto/client/updates';
import bigInt from 'big-integer';
import { createClient } from '../src/telegram.js';
import { createHandler } from '../src/handler.js';
import { Commands } from '../src/commands.js';
import { ADMIN_ID } from '../src/config.js';
import { fixture } from './helpers.js';

function wire(t) {
  const { store, rule } = fixture();
  const client = createClient({ apiId: 123, apiHash: 'a'.repeat(32) }, '');
  client._selfInputPeer = new Api.InputPeerUser({ userId: bigInt('777'), accessHash: bigInt('1') });
  const sent = [];
  client.sendMessage = async (peer, params) => sent.push({ peer, ...params });
  client.addEventHandler(createHandler(store, new Commands(client, store, {})), new NewMessage({}));
  t.after(async () => { await client.destroy(); store.close(); });
  const deliver = async (msg, entities = []) => {
    const update = msg.post
      ? new Api.UpdateNewChannelMessage({ message: msg, pts: 1, ptsCount: 1 })
      : new Api.UpdateNewMessage({ message: msg, pts: 1, ptsCount: 1 });
    update._entities = new Map(entities.map(e => [utils.getPeerId(e), e]));
    await _dispatchUpdate(client, { update });
  };
  return { store, rule, sent, deliver };
}

test('real MTProto NewMessage dispatch authorizes incoming admin and obtains access hash', async t => {
  const { deliver, sent, store } = wire(t);
  const admin = new Api.User({ id: bigInt(ADMIN_ID), accessHash: bigInt('22'), firstName: 'Admin' });
  await deliver(new Api.Message({ id: 1, peerId: new Api.PeerUser({ userId: admin.id }),
    fromId: new Api.PeerUser({ userId: admin.id }), message: '/pause', date: 1 }), [admin]);
  assert.equal(store.get('paused'), '1');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].peer instanceof Api.InputPeerUser);
  assert.equal(sent[0].peer.userId.toString(), ADMIN_ID);
});

test('real MTProto channel post without fromId matches channel whitelist', async t => {
  const { deliver, store } = wire(t);
  store.setDestination('99'); store.addSource('-100222'); store.addRule('-100222');
  await deliver(new Api.Message({ id: 20, peerId: new Api.PeerChannel({ channelId: bigInt('222') }),
    post: true, message: 'Channel post', date: 1 }));
  assert.equal(store.pendingCount(), 1);
  assert.equal(store.nextJob().source, '-100222');
});

test('real MTProto group reply preserves original-first ordering', async t => {
  const { deliver, store, rule } = wire(t);
  store.toggle(rule.id, 'replies', true);
  await deliver(new Api.Message({ id: 20, peerId: new Api.PeerChannel({ channelId: bigInt('111') }),
    fromId: new Api.PeerUser({ userId: bigInt('42') }), message: 'Reply', date: 1,
    replyTo: new Api.MessageReplyHeader({ replyToMsgId: 10 }) }));
  assert.equal(store.pendingCount(), 2);
  assert.equal(store.nextJob().message_id, 10);
});
