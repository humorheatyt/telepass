import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixture } from './helpers.js';
import { Store, MAX_PENDING } from '../src/db.js';

test('SQLite preserves configuration, random IDs and queue on restart', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'telepass-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'db.sqlite');
  let { store, rule } = fixture(file);
  store.enqueue('-100111', [5, 6], '-100222', rule.id);
  const random = store.nextJob().random_id;
  store.set('paused', 1); store.set('forward_not_before', 123456789); store.close();
  store = new Store(file); t.after(() => store.close());
  assert.equal(store.pendingCount(), 2);
  assert.equal(store.nextJob().random_id, random);
  assert.equal(store.rules().length, 1);
  assert.equal(store.sources().length, 1);
  assert.equal(store.get('paused'), '1');
  assert.equal(store.get('forward_not_before'), '123456789');
});

test('source/destination loop and destination changes with pending jobs are rejected', t => {
  const { store, rule } = fixture(); t.after(() => store.close());
  assert.throws(() => store.addSource('-100222'));
  assert.throws(() => store.setDestination('-100111'));
  store.enqueue('-100111', [1], '-100222', rule.id);
  assert.throws(() => store.setDestination('99'));
  assert.doesNotThrow(() => store.setDestination('-100222'));
  store.clearPending(); store.setDestination('99');
  assert.equal(store.get('destination'), '99');
});

test('validates whitelist types, options and deletion IDs', t => {
  const { store, rule, peer } = fixture(); t.after(() => store.close());
  peer('-33', 'chat');
  const basicGroup = store.addRule('-33');
  assert.equal(basicGroup.kind, 'chat');
  const channel = store.addRule('-100222');
  assert.doesNotThrow(() => store.toggle(channel.id, 'replies', true));
  const group = store.addRule('-100111');
  assert.equal(group.kind, 'supergroup');
  store.toggle(group.id, 'forwards', false);
  store.toggle(group.id, 'replies', true);
  assert.equal(store.rule(group.id).forwards, 0);
  assert.equal(store.rule(group.id).replies, 1);
  assert.throws(() => store.toggle(rule.id, 'injected', true));
  assert.throws(() => store.removeRule(100));
});

test('removing source or whitelist cancels its pending jobs', t => {
  const { store, rule } = fixture(); t.after(() => store.close());
  store.enqueue('-100111', [1], '-100222', rule.id);
  store.removeRule(rule.id); assert.equal(store.pendingCount(), 0);
  const r2 = store.addRule('42');
  store.enqueue('-100111', [2], '-100222', r2.id);
  store.removeSource('-100111'); assert.equal(store.pendingCount(), 0);
});

test('queue capacity is bounded and multi-message insertion is atomic', t => {
  const { store, rule } = fixture(); t.after(() => store.close());
  store.enqueue('-100111', Array.from({ length: MAX_PENDING - 1 }, (_, i) => i + 1), '-100222', rule.id);
  assert.throws(() => store.enqueue('-100111', [6000, 6001], '-100222', rule.id), /QUEUE_FULL/);
  assert.equal(store.pendingCount(), MAX_PENDING - 1);
  assert.equal(store.db.prepare('SELECT 1 FROM jobs WHERE message_id=6000').get(), undefined);
});

test('retention removes old completed jobs but never pending jobs', t => {
  const { store, rule } = fixture(); t.after(() => store.close());
  store.enqueue('-100111', [1, 2], '-100222', rule.id, 0);
  store.done(store.nextJob().id, 0);
  store.prune(8 * 86400000);
  assert.equal(store.pendingCount(), 1);
  assert.equal(store.stats().length, 1);
});

for (const target of ['source', 'rule']) {
  test(`removing a ${target} rolls back if cancelling its queue fails`, t => {
    const { store, rule } = fixture(); t.after(() => store.close());
    store.enqueue('-100111', [1], '-100222', rule.id);
    // Simulate an interrupted/failing second statement, after config deletion.
    store.db.exec(`CREATE TRIGGER reject_job_delete BEFORE DELETE ON jobs
      BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
    assert.throws(() => target === 'source' ? store.removeSource('-100111') : store.removeRule(rule.id), /simulated failure/);
    assert.equal(store.pendingCount(), 1);
    assert.equal(store.hasSource('-100111'), true);
    assert.ok(store.rule(rule.id));
    store.db.exec('DROP TRIGGER reject_job_delete');
    if (target === 'source') store.removeSource('-100111');
    else store.removeRule(rule.id);
    assert.equal(store.pendingCount(), 0);
  });
}
