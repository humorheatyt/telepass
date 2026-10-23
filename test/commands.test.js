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

test('English menu, Persian/English digit input, cancel and expiry work', async t => {
  const { commands, store } = setup(t);
  assert.match(await commands.execute('/menu'), /Telepass Admin Menu/);
  assert.match(await commands.execute('۳'), /Whitelist/);
  assert.match(await commands.execute('32'), /person, group, or channel/i);
  await commands.execute('/cancel');
  await assert.rejects(commands.execute('/allow remove 99'), /rule not found/i);
  await commands.execute('22'); await commands.execute('/cancel');
  assert.equal(commands.pending, null);
  await commands.execute('22'); commands.pending.expires = 0;
  await assert.rejects(commands.execute('99'), /expired/i);
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

test('bulk toggles update existing rules only and validate field/value', async t => {
  const { commands, store } = setup(t);
  store.addRule('99');
  await commands.execute('/rule all forwards off');
  await commands.execute('/rule all replies on');
  assert.ok(store.rules().every(r => r.forwards === 0 && r.replies === 1));
  const group = store.addRule('-100111');
  assert.equal(group.forwards, 1); assert.equal(group.replies, 0);
  await assert.rejects(commands.execute('/rule all invalid on'), /Invalid setting/);
  await assert.rejects(commands.execute('/rule all replies yes'), /on or off/);
});

test('JSON export/sample upload and authorized import document flow', async t => {
  const { commands, store, client } = setup(t);
  const files = [];
  client.sendFile = async (target, params) => files.push(params);
  const admin = extra => message({ senderId: ADMIN_ID, isPrivate: true, getInputSender: async () => 'admin-peer', ...extra });
  await commands.handle(admin({ message: '/data export' }));
  await commands.handle(admin({ message: '/data sample' }));
  assert.equal(files.length, 2);
  assert.equal(files[0].file.name, 'telepass-backup.json');
  await assert.rejects(commands.execute('/data import merge confirm'), /pause/);
  await commands.execute('/pause');
  await commands.execute('/data import merge confirm');
  const { sampleData } = await import('../src/backup.js');
  client.downloadMedia = async () => Buffer.from(JSON.stringify(sampleData()));
  let waited = false; commands.beforeImport = async () => { waited = true; };
  await commands.handle(admin({ message: '', document: { size: 1000 } }));
  assert.equal(waited, true);
  assert.ok(store.ruleFor('-100111'));
  assert.equal(commands.pending, null);
  assert.equal(store.get('paused'), '1');
});

test('admin help and all submenus send copyable command entities', async t => {
  const { commands, sent } = setup(t);
  for (const input of ['/help', '2', '3', '4', '6', '8']) {
    await commands.handle(message({ senderId: ADMIN_ID, isPrivate: true,
      getInputSender: async () => 'admin-peer', message: input }));
    const response = sent.at(-1);
    assert.equal(response.parseMode, false);
    assert.equal(response.linkPreview, false);
    assert.ok(response.formattingEntities.length > 0, input);
    const spans = response.formattingEntities.map(entity => response.message.slice(entity.offset, entity.offset + entity.length));
    assert.ok(spans.every(span => span.startsWith('/')));
    if (input === '8') {
      assert.ok(spans.includes('/data export'));
      assert.ok(spans.includes('/data import replace confirm'));
      for (const n of [81, 82, 83, 84, 85, 86, 0]) assert.match(response.message, new RegExp(`(?:^|\\n)${n} —`));
    }
  }
});

test('numbered backup downloads work with English, Persian and Arabic digits', async t => {
  const { commands, client } = setup(t);
  const files = [];
  client.sendFile = async (target, params) => files.push({ target, ...params });
  for (const input of ['81', '۸۲', '٨١']) {
    await commands.handle(message({ senderId: ADMIN_ID, isPrivate: true,
      getInputSender: async () => 'admin-peer', message: input }));
  }
  assert.deepEqual(files.map(file => file.file.name), ['telepass-backup.json', 'telepass-sample.json', 'telepass-backup.json']);
  assert.ok(files.every(file => file.target === 'admin-peer'));
});

test('numbered imports require pause and explicit confirmation and support cancel/expiry', async t => {
  const { commands, store } = setup(t);
  await assert.rejects(commands.execute('83'), /pause/i);
  assert.equal(commands.pending, null);
  await commands.execute('۸۵');
  assert.equal(store.get('paused'), '1');
  await commands.execute('83');
  assert.equal(commands.pending.prefix, '/data import merge');
  await commands.execute('confirm');
  assert.equal(commands.pending.importMode, 'merge');
  assert.equal(store.rules().length, 1);
  await commands.execute('/cancel');
  assert.match(await commands.execute('84'), /ALL database data/);
  await commands.execute('confirm');
  assert.equal(commands.pending.importMode, 'replace');
  await commands.execute('0');
  assert.equal(commands.pending, null);
  await commands.execute('84');
  commands.pending.expires = 0;
  await assert.rejects(commands.execute('confirm'), /expired/i);
  assert.equal(commands.pending, null);
  await commands.execute('86');
  assert.equal(store.get('paused'), '0');
});

test('numbered queue clearing requires confirmation and can be cancelled', async t => {
  const { commands, store, rule } = setup(t);
  store.enqueue('-100111', [10], '-100222', rule.id);
  assert.match(await commands.execute('6'), /62 —/);
  await commands.execute('62');
  assert.equal(store.pendingCount(), 1);
  await commands.execute('/cancel');
  assert.equal(store.pendingCount(), 1);
  await commands.execute('62');
  await commands.execute('confirm');
  assert.equal(store.pendingCount(), 0);
});

test('source submenu shortcuts and numeric reference inputs do not conflict', async t => {
  const { commands, store } = setup(t);
  assert.match(await commands.execute('25'), /Saved 3 IDs/);
  await commands.execute('24');
  assert.equal(commands.pending.prefix, '/join');
  await commands.execute('0');
  await commands.execute('26');
  assert.equal(commands.pending.prefix, '/linked');
  await commands.execute('/cancel');
  // 81 is data-export only outside an input prompt.
  store.savePeer({ id: '81', kind: 'user', raw_id: '81', access_hash: '1', name: 'User', username: null, reference: '81' });
  await commands.execute('32');
  await commands.handle(message({ senderId: ADMIN_ID, isPrivate: true,
    getInputSender: async () => 'admin-peer', message: '81' }));
  assert.ok(store.ruleFor('81'));
});
