import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { exportData, importData, parseBackup, sampleData } from '../src/backup.js';

const json = store => JSON.stringify(exportData(store));
test('full JSON roundtrip retains pending random IDs, errors, rules and peers', t => {
  const { store, rule } = fixture(); t.after(() => store.close());
  store.enqueue('-100111', [8, 10], '-100222', rule.id);
  store.fail(store.nextJob().id, 'MESSAGE_EMPTY');
  store.toggle(rule.id, 'replies', true);
  store.set('paused', '1');
  const before = exportData(store);
  importData(store, JSON.stringify(before), 'replace');
  const after = exportData(store);
  // Import deliberately preserves/initializes the flood-wait deadline.
  after.settings = after.settings.filter(s => s.key !== 'forward_not_before');
  assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)));
});

test('merge updates options, adds new rules, remaps rule collisions and never replays existing jobs', t => {
  const { store, rule, peer } = fixture(); t.after(() => store.close());
  store.enqueue('-100111', [10], '-100222', rule.id);
  store.done(store.nextJob().id);
  const data = exportData(store);
  data.jobs[0].status = 'pending'; data.jobs[0].finished_at = null;
  data.rules[0].replies = 1;
  data.rules[0].id = 88;
  data.jobs[0].rule_id = 88;
  peer('55', 'user');
  store.addRule('55');
  store.set('paused', '1');
  importData(store, JSON.stringify(data), 'merge');
  assert.equal(store.ruleFor('42').replies, 1);
  assert.ok(store.ruleFor('55'));
  assert.equal(store.pendingCount(), 0);
  assert.equal(store.db.prepare('SELECT rule_id FROM jobs').get().rule_id, rule.id);
});

test('imports require pause and reject corrupt fields/references/options atomically', t => {
  const { store } = fixture(); t.after(() => store.close());
  assert.throws(() => importData(store, json(store), 'replace'), /Pause first/);
  store.set('paused', '1');
  const before = json(store);
  for (const mutate of [d => d.rules[0].replies = 2, d => d.sources[0].peer_id = '-100999', d => d.peers[0].id = '1', d => d.jobs.push({}), d => d.settings.push({ key: 'paused', value: 'bad' })]) {
    const data = JSON.parse(before); mutate(data);
    assert.throws(() => importData(store, JSON.stringify(data), 'replace'), /Invalid JSON/);
    assert.equal(json(store), before);
  }
  assert.throws(() => parseBackup('{'), /malformed/);
  assert.throws(() => parseBackup(' '.repeat(8 * 1024 * 1024 + 1)), /maximum size/);
});

test('merge conflict rolls back, replacement retains local account and flood waits', t => {
  const { store, peer } = fixture(); t.after(() => store.close());
  store.set('paused', '1'); store.set('account_id', '777'); store.set('forward_not_before', '999999');
  peer('-100333', 'channel'); store.addSource('-100333');
  const data = sampleData(); data.peers.push(store.peer('-100333'));
  data.settings.find(s => s.key === 'destination').value = '-100333';
  const before = json(store);
  assert.throws(() => importData(store, JSON.stringify(data), 'merge'), /conflicts/);
  assert.equal(json(store), before);
  importData(store, JSON.stringify(sampleData()), 'replace');
  assert.equal(store.get('account_id'), '777');
  assert.equal(store.get('forward_not_before'), '999999');
  assert.equal(store.get('paused'), '1');
});
