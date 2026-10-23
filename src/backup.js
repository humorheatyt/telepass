import { UserError } from './errors.js';

export const MAX_JSON_BYTES = 8 * 1024 * 1024;
const columns = {
  settings: ['key', 'value'],
  peers: ['id', 'kind', 'raw_id', 'access_hash', 'name', 'username', 'reference'],
  sources: ['peer_id'],
  rules: ['id', 'peer_id', 'forwards', 'replies'],
  jobs: ['id', 'source', 'message_id', 'destination', 'rule_id', 'random_id', 'status', 'attempts', 'next_at', 'created_at', 'finished_at', 'error']
};
const fail = text => { throw new UserError(`Invalid JSON backup: ${text}`); };
const integer = (v, min = 0) => Number.isSafeInteger(v) && v >= min;
const decimal = v => typeof v === 'string' && /^-?\d{1,20}$/.test(v);
const peerId = v => typeof v === 'string' && /^-?[1-9]\d{0,19}$/.test(v);

export function exportData(store) {
  return { format: 'telepass', version: 1, ...Object.fromEntries(Object.keys(columns).map(table =>
    [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY ${table === 'settings' ? 'key' : table === 'sources' ? 'peer_id' : 'id'}`).all()])) };
}

export function parseBackup(text) {
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) fail('maximum size is 8 MiB.');
  let data;
  try { data = JSON.parse(text); } catch { fail('malformed JSON.'); }
  if (!data || data.format !== 'telepass' || data.version !== 1) fail('unsupported format/version.');
  if (Object.keys(data).some(k => !['format', 'version', ...Object.keys(columns)].includes(k))) fail('unknown top-level field.');
  for (const [table, fields] of Object.entries(columns)) {
    if (!Array.isArray(data[table]) || data[table].length > (table === 'jobs' ? 25000 : 20000)) fail(`invalid ${table} array.`);
    const seen = new Set();
    for (const row of data[table]) {
      if (!row || Object.keys(row).length !== fields.length || fields.some(k => !Object.hasOwn(row, k))) fail(`invalid ${table} fields.`);
      if (Object.values(row).some(v => !(v === null || typeof v === 'string' && v.length <= 8192 || Number.isSafeInteger(v)))) fail(`invalid ${table} value.`);
      const key = row[fields[0]];
      if (seen.has(key)) fail(`duplicate ${table} key.`);
      seen.add(key);
    }
  }
  for (const r of data.settings) if (typeof r.key !== 'string' || !r.key || typeof r.value !== 'string') fail('invalid setting.');
  for (const p of data.peers) {
    if (!['user', 'chat', 'channel', 'supergroup'].includes(p.kind) || !peerId(p.id) || !/^[1-9]\d*$/.test(p.raw_id) || typeof p.raw_id !== 'string' ||
      p.id !== (p.kind === 'user' ? p.raw_id : p.kind === 'chat' ? `-${p.raw_id}` : `-100${p.raw_id}`) ||
      !(p.access_hash === null || decimal(p.access_hash)) || typeof p.name !== 'string' || typeof p.reference !== 'string' || !(p.username === null || typeof p.username === 'string')) fail('invalid peer.');
  }
  const peers = new Map(data.peers.map(p => [p.id, p]));
  const sources = new Set(data.sources.map(s => s.peer_id));
  for (const s of sources) if (!peers.has(s) || peers.get(s).kind === 'user') fail('source must reference a saved group/channel.');
  const rulePeers = new Set();
  for (const r of data.rules) {
    if (!integer(r.id, 1) || !peers.has(r.peer_id) || rulePeers.has(r.peer_id) || ![0, 1].includes(r.forwards) || ![0, 1].includes(r.replies)) fail('invalid rule.');
    rulePeers.add(r.peer_id);
  }
  const ruleIds = new Set(data.rules.map(r => r.id));
  const jobKeys = new Set();
  for (const j of data.jobs) {
    const key = JSON.stringify([j.source, j.message_id, j.destination]);
    if (!integer(j.id, 1) || !integer(j.message_id, 1) || j.message_id > 2147483647 || !peerId(j.source) || !peerId(j.destination) ||
      !integer(j.rule_id, 1) || !decimal(j.random_id) || BigInt(j.random_id) < -(2n ** 63n) || BigInt(j.random_id) >= 2n ** 63n ||
      !['pending', 'done', 'failed'].includes(j.status) || !integer(j.attempts) || !integer(j.next_at) || !integer(j.created_at) ||
      !(j.finished_at === null || integer(j.finished_at)) || !(j.error === null || typeof j.error === 'string') || jobKeys.has(key)) fail('invalid job.');
    jobKeys.add(key);
    if (j.status === 'pending' && (!sources.has(j.source) || !peers.has(j.destination) || !ruleIds.has(j.rule_id) || j.source === j.destination)) fail('pending job references missing data.');
  }
  if (data.jobs.filter(j => j.status === 'pending').length > 5000) fail('too many pending jobs.');
  const settings = Object.fromEntries(data.settings.map(s => [s.key, s.value]));
  if (settings.destination && (!peers.has(settings.destination) || sources.has(settings.destination))) fail('invalid destination.');
  if (settings.paused !== undefined && !['0', '1'].includes(settings.paused)) fail('invalid paused flag.');
  for (const key of ['forward_not_before', 'overflow_events', 'last_overflow']) {
    if (settings[key] !== undefined && (!/^\d+$/.test(settings[key]) || !Number.isSafeInteger(Number(settings[key])))) fail(`invalid ${key}.`);
  }
  return data;
}

export function importData(store, text, mode) {
  if (!['merge', 'replace'].includes(mode)) fail('mode must be merge or replace.');
  if (store.get('paused') !== '1') throw new UserError('Pause first with /pause, then wait for any in-progress delivery to finish.');
  const data = parseBackup(text);
  store.transaction(() => {
    // Never load runtime account identity from another installation.
    const account = store.get('account_id');
    const waitUntil = Number(store.get('forward_not_before', '0'));
    if (mode === 'replace') for (const table of ['jobs', 'rules', 'sources', 'peers', 'settings']) store.db.exec(`DELETE FROM ${table}`);
    for (const p of data.peers) store.savePeer(p);
    for (const s of data.settings) if (!['paused', 'account_id', 'destination'].includes(s.key)) store.set(s.key, s.value);
    const destination = data.settings.find(s => s.key === 'destination');
    if (destination) store.set('destination', destination.value);
    for (const s of data.sources) store.addSource(s.peer_id);
    if (store.hasSource(store.get('destination'))) fail('destination conflicts with an existing source.');
    const ruleMap = new Map();
    for (const r of data.rules) {
      let rule = store.ruleFor(r.peer_id);
      if (!rule) {
        // Preserve exported numbers where possible; merge remaps collisions.
        if (!store.rule(r.id)) store.db.prepare('INSERT INTO rules(id,peer_id,forwards,replies) VALUES (?,?,?,?)').run(r.id, r.peer_id, r.forwards, r.replies);
        else store.addRule(r.peer_id);
        rule = store.ruleFor(r.peer_id);
      }
      store.toggle(rule.id, 'forwards', !!r.forwards);
      store.toggle(rule.id, 'replies', !!r.replies);
      ruleMap.set(r.id, rule.id);
    }
    const fields = columns.jobs.filter(k => k !== 'id');
    const insert = store.db.prepare(`INSERT INTO jobs(${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')}) ON CONFLICT(source,message_id,destination) DO NOTHING`);
    for (const j of data.jobs) {
      // Existing delivery history wins in merge mode: do not replay sent jobs.
      const row = { ...j, rule_id: ruleMap.get(j.rule_id) ?? j.rule_id };
      if (mode === 'replace') store.db.prepare(`INSERT INTO jobs(${columns.jobs.join(',')}) VALUES (${columns.jobs.map(() => '?').join(',')})`).run(...columns.jobs.map(k => row[k]));
      else insert.run(...fields.map(k => row[k]));
    }
    if (store.pendingCount() > 5000) fail('merged queue exceeds 5000 jobs.');
    if (account) store.set('account_id', account);
    store.set('forward_not_before', Math.max(waitUntil, Number(store.get('forward_not_before', '0'))));
    store.set('paused', '1');
  });
  return 'Import completed atomically. Still paused. Check /status, /source list and /allow list before /resume.';
}

export function sampleData() {
  return {
    format: 'telepass', version: 1,
    settings: [{ key: 'paused', value: '1' }, { key: 'destination', value: '-100222' }],
    peers: [
      { id: '-100111', kind: 'supergroup', raw_id: '111', access_hash: '123', name: 'TEST source group', username: null, reference: '-100111' },
      { id: '-100222', kind: 'channel', raw_id: '222', access_hash: '456', name: 'TEST destination', username: null, reference: '-100222' },
      { id: '42', kind: 'user', raw_id: '42', access_hash: '789', name: 'TEST user', username: null, reference: '42' }
    ],
    sources: [{ peer_id: '-100111' }],
    rules: [{ id: 1, peer_id: '42', forwards: 1, replies: 0 }, { id: 2, peer_id: '-100111', forwards: 1, replies: 0 }],
    jobs: []
  };
}
