import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api } from 'teleproto';
import bigInt from 'big-integer';
import { parseReference, peerRecord, inputPeer, PeerService } from '../src/peers.js';
import { fixture } from './helpers.js';

test('normalizes numeric IDs without precision loss and accepts Telegram link formats', () => {
  for (const input of ['@someone', 'someone', 'https://t.me/someone/123?single', 't.me/s/someone/8']) {
    assert.deepEqual(parseReference(input), { type: 'username', value: 'someone' });
  }
  assert.deepEqual(parseReference('-1001234567890123'), { type: 'id', value: '-1001234567890123' });
  assert.deepEqual(parseReference('t.me/c/1234567890/5'), { type: 'id', value: '-1001234567890' });
  assert.deepEqual(parseReference('https://t.me/+Secret_123'), { type: 'invite', value: 'Secret_123' });
  assert.deepEqual(parseReference('https://t.me/joinchat/Secret-123'), { type: 'invite', value: 'Secret-123' });
  assert.equal(parseReference('+989123456789').type, 'phone');
});

test('rejects unrelated, spoofed URLs and malformed references', () => {
  for (const input of ['', 'https://example.com/test', 'https://t.me.evil.com/name', 'ftp://t.me/name', 'https://x@t.me/name', 'name with spaces', 't.me/+', 'https://t.me:123/name']) {
    assert.throws(() => parseReference(input), input);
  }
});

test('entity records retain display name, original reference and exact access hashes', () => {
  const user = new Api.User({ id: bigInt('42'), accessHash: bigInt('9223372036854775806'), firstName: 'علی', username: 'someone' });
  const row = peerRecord(user, 't.me/someone');
  assert.equal(row.id, '42'); assert.equal(row.name, 'علی');
  assert.equal(row.reference, 't.me/someone');
  assert.equal(inputPeer(row).accessHash.toString(), '9223372036854775806');
  const channel = new Api.Channel({ id: bigInt('1234567890'), accessHash: bigInt('32'), title: 'کانال', broadcast: true });
  const p = peerRecord(channel);
  assert.equal(p.id, '-1001234567890'); assert.equal(p.kind, 'channel');
  channel.megagroup = true; assert.equal(peerRecord(channel).kind, 'supergroup');
});

test('numeric resolution uses SQLite access hashes, not just the volatile library cache', async t => {
  const { store } = fixture(); t.after(() => store.close());
  let received;
  const user = new Api.User({ id: bigInt('42'), accessHash: bigInt('123456'), firstName: 'Alice' });
  const peers = new PeerService({ getEntity: async input => { received = input; return user; } }, store);
  const { peer } = await peers.resolve('42');
  assert.ok(received instanceof Api.InputPeerUser);
  assert.equal(peer.name, 'Alice');
});

test('private invite never silently joins when adding a source', async t => {
  const { store } = fixture(); t.after(() => store.close());
  const calls = [];
  const channel = new Api.Channel({ id: bigInt('123'), accessHash: bigInt('456'), title: 'Private' });
  const peers = new PeerService({ invoke: async req => {
    calls.push(req);
    if (req instanceof Api.messages.CheckChatInvite) return {};
    return { chats: [channel] };
  } }, store);
  await assert.rejects(peers.resolve('t.me/+Invite_123'), /join/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0] instanceof Api.messages.CheckChatInvite);
  const result = await peers.resolve('t.me/+Invite_123', { join: true });
  assert.equal(result.peer.id, '-100123');
  assert.ok(calls.at(-1) instanceof Api.messages.ImportChatInvite);
});
