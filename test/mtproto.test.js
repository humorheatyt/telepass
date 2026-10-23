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
import { peerRecord } from '../src/peers.js';
import { ForwardWorker } from '../src/worker.js';

function wire(t) {
  const { store, rule } = fixture();
  const client = createClient({ apiId: 123, apiHash: 'a'.repeat(32) }, '');
  client._selfInputPeer = new Api.InputPeerUser({ userId: bigInt('777'), accessHash: bigInt('1') });
  const sent = [];
  client.sendMessage = async (peer, params) => sent.push({ peer, ...params });
  client.addEventHandler(createHandler(store, new Commands(client, store, {})), new NewMessage({}));
  t.after(async () => { await client.destroy(); store.close(); });
  const deliver = async (msg, entities = []) => {
    const update = msg.peerId instanceof Api.PeerChannel
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

test('real anonymous group owner and linked-channel discussion posts use visible identities', async t => {
  const { deliver, store, rule } = wire(t);
  // Whitelisting the hidden human alone cannot identify an anonymous message.
  const anonymous = id => new Api.Message({ id, peerId: new Api.PeerChannel({ channelId: bigInt('111') }),
    fromId: new Api.PeerChannel({ channelId: bigInt('111') }), postAuthor: 'Owner', message: 'Anonymous', date: 1 });
  await deliver(anonymous(30));
  assert.equal(store.pendingCount(), 0);
  const group = store.addRule('-100111');
  await deliver(anonymous(31));
  assert.equal(store.nextJob().rule_id, group.id);
  store.clearPending();
  const channel = store.addRule('-100222');
  const discussion = id => new Api.Message({ id, peerId: new Api.PeerChannel({ channelId: bigInt('111') }),
    fromId: new Api.PeerChannel({ channelId: bigInt('222') }),
    fwdFrom: new Api.MessageFwdHeader({ date: 1, fromId: new Api.PeerChannel({ channelId: bigInt('222') }), channelPost: 5 }),
    message: 'Discussion post', date: 1 });
  await deliver(discussion(32));
  assert.equal(store.nextJob().rule_id, channel.id);
  store.clearPending(); store.toggle(channel.id, 'forwards', false);
  await deliver(discussion(33));
  assert.equal(store.pendingCount(), 0);
});

test('anonymous supergroup messages without fromId use the group rule, not the hidden owner', async t => {
  const { deliver, store } = wire(t);
  const anonymous = (id, extra = {}) => new Api.Message({
    id, peerId: new Api.PeerChannel({ channelId: bigInt('111') }),
    message: 'Anonymous without explicit sender', date: 1, ...extra
  });
  await deliver(anonymous(40, { postAuthor: 'Owner' }));
  assert.equal(store.pendingCount(), 0, 'a human whitelist alone must not authorize anonymous messages');
  const group = store.addRule('-100111');
  store.toggle(group.id, 'replies', true);
  await deliver(anonymous(41, { replyTo: new Api.MessageReplyHeader({ replyToMsgId: 39 }) }));
  assert.deepEqual(store.db.prepare('SELECT message_id,rule_id FROM jobs ORDER BY id').all()
    .map(job => [job.message_id, job.rule_id]), [[39, group.id], [41, group.id]]);
  store.clearPending();
  store.toggle(group.id, 'forwards', false);
  await deliver(anonymous(42, { fwdFrom: new Api.MessageFwdHeader({ date: 1,
    fromId: new Api.PeerUser({ userId: bigInt('42') }) }) }));
  await deliver(anonymous(43, { fromId: new Api.PeerUser({ userId: bigInt('123') }), postAuthor: 'Owner' }));
  await deliver(anonymous(44, { fromId: new Api.PeerChannel({ channelId: bigInt('333') }) }));
  await deliver(anonymous(45, { out: true }));
  assert.equal(store.pendingCount(), 0, 'forwards, other senders and unidentified outgoing messages stay excluded');
});

test('private group forwards anonymous owner/admin messages without any public username', async t => {
  const { deliver, store } = wire(t);
  const group = new Api.Channel({
    id: bigInt('987654321'), accessHash: bigInt('876543210987654321'),
    title: 'Private group', megagroup: true,
    photo: new Api.ChatPhotoEmpty(), date: 1
  });
  const saved = store.savePeer(peerRecord(group, 'https://t.me/+PrivateInvite'));
  assert.equal(saved.username, null);
  store.addSource(saved.id);
  const rule = store.addRule(saved.id);
  // These titles are display-only. All roles must match the group rule,
  // whether Telegram supplies an explicit group sender or omits it.
  const cases = [
    { postAuthor: 'Owner', fromId: new Api.PeerChannel({ channelId: group.id }) },
    { postAuthor: 'Administrator', fromId: new Api.PeerChannel({ channelId: group.id }) },
    { postAuthor: 'Owner' },
    { postAuthor: 'Administrator' },
    {} // An anonymous admin does not need a title/signature.
  ];
  for (const [i, extra] of cases.entries()) {
    await deliver(new Api.Message({
      id: 100 + i, peerId: new Api.PeerChannel({ channelId: group.id }),
      message: 'Anonymous in private group', date: 1, ...extra
    }), [group]);
  }
  const jobs = store.db.prepare('SELECT source,message_id,rule_id FROM jobs ORDER BY id').all();
  assert.deepEqual(jobs.map(job => [job.source, job.message_id, job.rule_id]),
    cases.map((_, i) => [saved.id, 100 + i, rule.id]));

  // Exercise the delivery boundary too: private sources must use their saved
  // access hash, not attempt public-username resolution.
  const requests = [];
  const worker = new ForwardWorker({ connected: true, invoke: async request => {
    assert.ok(request instanceof Api.messages.ForwardMessages);
    assert.ok(request.fromPeer instanceof Api.InputPeerChannel);
    assert.equal(request.fromPeer.channelId.toString(), group.id.toString());
    assert.equal(request.fromPeer.accessHash.toString(), group.accessHash.toString());
    request.getBytes();
    requests.push(request);
  } }, store);
  for (const _ of cases) await worker.tick();
  assert.deepEqual(requests.map(request => request.id[0]), cases.map((_, i) => 100 + i));
  assert.equal(store.pendingCount(), 0);
  assert.equal(store.errors().length, 0);

  // Whitelisting this private group must not authorize an ordinary member or
  // another send-as-channel identity, even if the displayed title says Owner.
  for (const [i, fromId] of [new Api.PeerUser({ userId: bigInt('555') }),
    new Api.PeerChannel({ channelId: bigInt('666') })].entries()) {
    await deliver(new Api.Message({ id: 110 + i,
      peerId: new Api.PeerChannel({ channelId: group.id }), fromId,
      postAuthor: 'Owner', message: 'Not the group sender', date: 1
    }), [group]);
  }
  assert.equal(store.pendingCount(), 0);
});
