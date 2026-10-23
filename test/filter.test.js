import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, message } from './helpers.js';
import { matchMessage, isAdminMessage } from '../src/filter.js';
import { createHandler } from '../src/handler.js';
import { ADMIN_ID } from '../src/config.js';

test('only incoming private messages from the fixed administrator authorize commands', () => {
  assert.equal(isAdminMessage(message({ senderId: ADMIN_ID, isPrivate: true })), true);
  for (const overrides of [{ senderId: '42', isPrivate: true }, { senderId: ADMIN_ID }, { senderId: ADMIN_ID, isPrivate: true, out: true }]) {
    assert.equal(isAdminMessage(message(overrides)), false);
  }
});

test('requires source AND visible whitelisted sender AND destination', t => {
  const { store } = fixture(); t.after(() => store.close());
  assert.ok(matchMessage(store, message()));
  assert.equal(matchMessage(store, message({ chatId: '-100999' })), null);
  assert.equal(matchMessage(store, message({ senderId: '99', fwdFrom: { fromId: '42' } })), null);
  assert.equal(matchMessage(store, message({ senderId: null })), null);
  assert.equal(matchMessage(store, message({ action: {} })), null);
  assert.equal(matchMessage(store, message({ chatId: '-100222' })), null);
  store.set('paused', 1);
  assert.equal(matchMessage(store, message()), null);
  store.set('paused', 0); store.set('destination', '');
  assert.equal(matchMessage(store, message()), null);
});

test('forward toggle applies independently per rule, including channel posts', t => {
  const { store, rule } = fixture(); t.after(() => store.close());
  store.toggle(rule.id, 'forwards', false);
  assert.equal(matchMessage(store, message({ fwdFrom: {} })), null);
  assert.ok(matchMessage(store, message()));
  store.set('destination', '99'); store.addSource('-100222');
  const channelRule = store.addRule('-100222');
  const post = message({ senderId: '-100222', chatId: '-100222', fwdFrom: {} });
  assert.ok(matchMessage(store, post));
  store.toggle(channelRule.id, 'forwards', false);
  assert.equal(matchMessage(store, post), null);
  assert.ok(matchMessage(store, { ...post, fwdFrom: undefined }));
});

test('group whitelist supports anonymous send-as-group messages with independent per-rule options', async t => {
  const { store } = fixture(); t.after(() => store.close());
  const groupRule = store.addRule('-100111');
  store.toggle(groupRule.id, 'forwards', false);
  store.toggle(groupRule.id, 'replies', true);
  const anonymous = message({ senderId: '-100111', replyTo: { replyToMsgId: 8 } });
  assert.equal(matchMessage(store, { ...anonymous, fwdFrom: {} }), null);
  assert.equal(matchMessage(store, anonymous).rule.id, groupRule.id);
  await createHandler(store, {})({ message: anonymous });
  const jobs = store.db.prepare('SELECT message_id,rule_id FROM jobs ORDER BY id').all();
  assert.deepEqual(jobs.map(job => job.message_id), [8, 10]);
  assert.ok(jobs.every(job => job.rule_id === groupRule.id));
});

test('reply context queues before response and repeated events deduplicate', async t => {
  const { store, rule } = fixture(); t.after(() => store.close());
  const handler = createHandler(store, {});
  store.toggle(rule.id, 'replies', true);
  const event = { message: message({ replyTo: { replyToMsgId: 8 } }) };
  await handler(event); await handler(event);
  const jobs = store.db.prepare('SELECT message_id FROM jobs ORDER BY id').all();
  assert.deepEqual(jobs.map(j => j.message_id), [8, 10]);
});

test('reply context defaults off; cross-chat replies and forum topic headers are excluded', async t => {
  const { store, rule } = fixture(); t.after(() => store.close());
  const handler = createHandler(store, {});
  await handler({ message: message({ replyTo: { replyToMsgId: 8 } }) });
  assert.equal(store.pendingCount(), 1);
  store.toggle(rule.id, 'replies', true);
  await handler({ message: message({ id: 11, replyTo: { replyToMsgId: 7, replyToPeerId: {} } }) });
  await handler({ message: message({ id: 12, replyTo: { replyToMsgId: 6, forumTopic: true } }) });
  assert.equal(store.pendingCount(), 3);
});

test('admin private messages are commands, not forwarding candidates', async t => {
  const { store } = fixture(); t.after(() => store.close());
  let calls = 0;
  const handler = createHandler(store, { handle: async () => calls++ });
  await handler({ message: message({ senderId: ADMIN_ID, isPrivate: true }) });
  await handler({ message: message({ senderId: '99', isPrivate: true }) });
  assert.equal(calls, 1);
  assert.equal(store.pendingCount(), 0);
});


test('real replies inside forum topics still include their original message', async t => {
  const { store, rule } = fixture(); t.after(() => store.close());
  store.toggle(rule.id, 'replies', true);
  await createHandler(store, {})({ message: message({ replyTo: { replyToMsgId: 8, replyToTopId: 2, forumTopic: true } }) });
  assert.equal(store.nextJob().message_id, 8);
  assert.equal(store.pendingCount(), 2);
});

test('missing sender on its own never implies an anonymous group sender', t => {
  const { store } = fixture(); t.after(() => store.close());
  store.addRule('-100111');
  // A chatId or a display signature is not MTProto sender evidence.
  assert.equal(matchMessage(store, message({ senderId: null, postAuthor: 'Owner' })), null);
  assert.equal(isAdminMessage(message({ senderId: null, isPrivate: true, postAuthor: 'Owner' })), false);
});
