import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api } from 'teleproto';
import { fixture } from './helpers.js';
import { ForwardWorker } from '../src/worker.js';

function setup(t, invoke) {
  const { store, rule } = fixture(); t.after(() => store.close());
  store.enqueue('-100111', [8, 10], '-100222', rule.id);
  let clock = 100000;
  const client = { connected: true, invoke };
  const worker = new ForwardWorker(client, store, { now: () => clock });
  return { store, worker, client, advance: ms => { clock += ms; } };
}

test('forwards original then reply using serializable MTProto requests and stable random IDs', async t => {
  const calls = [];
  const { store, worker } = setup(t, async request => { calls.push(request); request.getBytes(); });
  const random = store.nextJob().random_id;
  await worker.tick(); await worker.tick();
  assert.ok(calls[0] instanceof Api.messages.ForwardMessages);
  assert.deepEqual(calls.map(c => c.id[0]), [8, 10]);
  assert.equal(calls[0].randomId[0].toString(), random);
  assert.equal(store.pendingCount(), 0);
});

test('flood wait survives in database and blocks later jobs until retry', async t => {
  let calls = 0;
  const { store, worker, advance } = setup(t, async () => {
    calls++; if (calls === 1) throw { errorMessage: 'FLOOD_WAIT_20', seconds: 20 };
  });
  await worker.tick();
  assert.equal(store.nextJob().next_at, 122000);
  assert.equal(store.nextJob().attempts, 0);
  await worker.tick(); assert.equal(calls, 1);
  advance(22000); await worker.tick();
  assert.equal(store.nextJob().message_id, 10);
});

test('transient error retries the same request without changing random ID', async t => {
  const ids = [];
  const { store, worker, advance } = setup(t, async request => {
    ids.push(request.randomId[0].toString());
    if (ids.length === 1) throw new Error('network timeout');
  });
  await worker.tick(); assert.equal(store.nextJob().attempts, 1);
  advance(2000); await worker.tick();
  assert.equal(ids[0], ids[1]);
  assert.equal(store.pendingCount(), 1);
});

test('protected content fails safely and next queued message still progresses', async t => {
  let calls = 0;
  const { store, worker } = setup(t, async () => {
    if (++calls === 1) throw { errorMessage: 'CHAT_FORWARDS_RESTRICTED' };
  });
  await worker.tick(); await worker.tick();
  assert.equal(store.errors()[0].error, 'CHAT_FORWARDS_RESTRICTED');
  assert.equal(store.pendingCount(), 0);
});

test('paused and disconnected workers do not send', async t => {
  let calls = 0;
  const { store, worker, client } = setup(t, async () => calls++);
  store.set('paused', 1); await worker.tick();
  store.set('paused', 0); client.connected = false; await worker.tick();
  assert.equal(calls, 0);
});

test('clearing the queue cannot bypass a persisted Telegram flood wait', async t => {
  let calls = 0;
  const { store, worker, advance } = setup(t, async () => {
    if (++calls === 1) throw { errorMessage: 'FLOOD_WAIT_20', seconds: 20 };
  });
  await worker.tick();
  assert.equal(store.get('forward_not_before'), '122000');
  store.clearPending();
  store.enqueue('-100111', [30], '-100222', store.ruleFor('42').id);
  // New worker, same SQLite state: neither deletion nor restart removes wait.
  const restarted = new ForwardWorker(worker.client, store, { now: worker.now });
  await restarted.tick(); assert.equal(calls, 1);
  advance(22000); await restarted.tick();
  assert.equal(calls, 2);
  assert.equal(store.pendingCount(), 0);
});

test('initially unconnected clients cannot attempt forwarding', async t => {
  let calls = 0;
  const { worker, client } = setup(t, async () => calls++);
  client.connected = undefined;
  await worker.tick();
  assert.equal(calls, 0);
});

test('ten transient failures become a visible final failure without retrying forever', async t => {
  let calls = 0;
  const { store, worker, advance } = setup(t, async () => { calls++; throw new Error('network timeout'); });
  for (let i = 0; i < 10; i++) { await worker.tick(); advance(300000); }
  assert.equal(calls, 10);
  assert.equal(store.errors().length, 1);
  assert.equal(store.nextJob().message_id, 10);
});
