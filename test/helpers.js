import { Store } from '../src/db.js';

export function fixture(filename = ':memory:') {
  const store = new Store(filename);
  const peer = (id, kind) => store.savePeer({ id, kind, raw_id: id.replace(/^-100/, '').replace(/^-/, ''),
    access_hash: kind === 'chat' ? null : '123456', name: `Name ${id}`, username: null, reference: id });
  peer('-100111', 'supergroup'); peer('-100222', 'channel'); peer('42', 'user'); peer('99', 'user');
  store.addSource('-100111'); store.setDestination('-100222');
  const rule = store.addRule('42');
  return { store, rule, peer };
}
export function message(extra = {}) {
  return { id: 10, chatId: '-100111', senderId: '42', message: 'sample', isPrivate: false, out: false, ...extra };
}
