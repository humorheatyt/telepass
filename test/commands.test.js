import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Commands } from '../src/commands.js';
import { ADMIN_ID } from '../src/config.js';
import { fixture, message } from './helpers.js';

function setup(t) {
  const { store, rule } = fixture(); t.after(() => store.close());
  const sent = [];
  const client = { connected: true, sendMessage: async (target, content) => sent.push({ target, ...content }) };
  const peers = { resolve: async ref => ({ peer: store.peer(ref), entity: { adminRights: { postMessages: true } } }), sync: async () => 3 };
  return { store, rule, sent, commands: new Commands(client, store, peers), client };
}

test('non-admin, group and outgoing commands cannot mutate state or receive a reply', async t => {
  const { store, commands, sent } = setup(t);
  for (const overrides of [{ senderId: '42', isPrivate: true }, { senderId: ADMIN_ID }, { senderId: ADMIN_ID, isPrivate: true, out: true }]) {
    await commands.handle(message({ ...overrides, message: '/pause' }));
  }
  assert.equal(store.get('paused'), null);
  assert.equal(sent.length, 0);
});

test('admin commands reply to the real input sender without formatting', async t => {
  const { store, commands, sent } = setup(t);
  await commands.handle(message({ senderId: ADMIN_ID, isPrivate: true, message: '/pause', getInputSender: async () => 'admin-peer' }));
  assert.equal(store.get('paused'), '1');
  assert.equal(sent[0].target, 'admin-peer');
  assert.equal(sent[0].parseMode, false);
  await commands.execute('/resume'); assert.equal(store.get('paused'), '0');
});

test('Persian menu prompts, cancel and expiry work', async t => {
  const { commands, store } = setup(t);
  assert.match(await commands.execute('/menu'), /مدیریت/);
  assert.match(await commands.execute('۳'), /وایت‌لیست/);
  assert.match(await commands.execute('۳۲'), /شناسه/);
  assert.match(await commands.execute('99'), /قانون/);
  assert.ok(store.ruleFor('99'));
  await commands.execute('22'); await commands.execute('/cancel');
  assert.equal(commands.pending, null);
  await commands.execute('22'); commands.pending.expires = 0;
  await assert.rejects(commands.execute('99'), /مهلت/);
});

test('rule toggles validate values, preserve options on re-add and list useful names/IDs', async t => {
  const { commands, store, rule } = setup(t);
  await commands.execute(`/rule ${rule.id} forwards off`);
  await commands.execute(`/rule ${rule.id} replies on`);
  await commands.execute('/allow add 42');
  assert.equal(store.rule(rule.id).forwards, 0);
  assert.equal(store.rule(rule.id).replies, 1);
  const list = await commands.execute('/allow list');
  assert.match(list, /Name 42/); assert.match(list, /ID: 42/); assert.match(list, /forwards: off/);
  await assert.rejects(commands.execute(`/rule ${rule.id} forwards yes`));
  await assert.rejects(commands.execute('/allow list 0'));
  await assert.rejects(commands.execute('/rule NaN replies on'));
});

test('destination is committed only after successful permission test', async t => {
  const { commands, store, client } = setup(t);
  client.sendMessage = async () => { throw { errorMessage: 'CHAT_WRITE_FORBIDDEN' }; };
  await assert.rejects(commands.execute('/destination set 99'));
  assert.equal(store.get('destination'), '-100222');
  client.sendMessage = async () => {};
  await commands.execute('/destination set 99');
  assert.equal(store.get('destination'), '99');
});

test('source deletion, queue clear confirmation and help are reachable', async t => {
  const { commands, store, rule } = setup(t);
  store.enqueue('-100111', [10], '-100222', rule.id);
  await assert.rejects(commands.execute('/queue clear'));
  assert.equal(store.pendingCount(), 1);
  await commands.execute('/queue clear confirm'); assert.equal(store.pendingCount(), 0);
  await commands.execute('/source remove -100111'); assert.equal(store.sources().length, 0);
  assert.match(await commands.execute('/help'), /\/join/);
  assert.match(await commands.execute('/status'), /RAM/);
});
