import { createServer } from 'node:http';
import { chmodSync } from 'node:fs';
import { NewMessage } from 'teleproto/events';
import { loadConfig, ADMIN_ID } from './config.js';
import { Store } from './db.js';
import { createClient, readSession, saveSession, acquireLock } from './telegram.js';
import { Commands } from './commands.js';
import { PeerService, peerRecord } from './peers.js';
import { ForwardWorker } from './worker.js';
import { createHandler } from './handler.js';
import { UserError, friendlyError, logError } from './errors.js';

async function main() {
  process.umask(0o077);
  const config = loadConfig();
  const session = readSession(config.sessionPath);
  if (!session) throw new UserError('نشست موجود نیست؛ ابتدا npm run login را در ترمینال اجرا کنید.');
  chmodSync(config.sessionPath, 0o600);
  let stopping = false, ready = false;
  let client, store, worker, health, maintenance, sessionTimer, release;
  const activeHandlers = new Set();
  const stop = async (exitCode = 0) => {
    if (stopping) return;
    stopping = true; ready = false;
    const deadline = setTimeout(() => process.exit(1), 15000);
    deadline.unref();
    clearInterval(maintenance); clearInterval(sessionTimer);
    health?.close();
    if (worker) { worker.running = false; clearTimeout(worker.timer); }
    const cleanup = [
      () => client?.destroy(),
      () => worker?.stop(),
      () => Promise.allSettled([...activeHandlers]),
      () => store?.close(),
      () => release?.()
    ];
    for (const action of cleanup) {
      try { await action(); }
      catch (error) { logError('shutdown', error); exitCode = 1; }
    }
    clearTimeout(deadline);
    process.exitCode = exitCode;
  };
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
  try {
    release = await acquireLock(config.sessionPath, () => { void stop(1); });
    if (stopping) { await release(); return; }
    store = new Store(config.dbPath);
    store.prune();
    client = createClient(config, session);
    await client.connect();
    if (stopping) return;
    const authorized = await client.checkAuthorization();
    if (stopping) return;
    if (!authorized) throw new UserError('نشست باطل شده؛ سرویس را متوقف و npm run login را دوباره اجرا کنید.');
    const me = await client.getMe();
    if (stopping) return;
    if (me.id.toString() === ADMIN_ID) throw new UserError('اکانت یوزربات باید از اکانت ادمین جدا باشد.');
    const previousAccount = store.get('account_id');
    if (previousAccount && previousAccount !== me.id.toString()) throw new UserError('این دیتابیس متعلق به اکانت دیگری است؛ برای اکانت جدید از DATA_DIR جداگانه استفاده کنید.');
    store.set('account_id', me.id.toString());
    store.savePeer(peerRecord(me, 'self'));
    const peers = new PeerService(client, store);
    const commands = new Commands(client, store, peers);
    const handler = createHandler(store, commands);
    client.addEventHandler(event => {
      if (stopping) return;
      const promise = handler(event);
      activeHandlers.add(promise);
      promise.finally(() => activeHandlers.delete(promise));
      return promise;
    }, new NewMessage({}));
    saveSession(client, config.sessionPath);
    worker = new ForwardWorker(client, store);
    worker.start();
    maintenance = setInterval(() => { try { store.prune(); } catch (e) { logError('maintenance', e); } }, 3600000);
    sessionTimer = setInterval(() => { try { saveSession(client, config.sessionPath); } catch (e) { logError('session_save', e); } }, 60000);
    if (config.port) {
      health = createServer((req, res) => {
        if (req.url !== '/health') { res.writeHead(404); res.end(); return; }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        const ok = ready && !!client.connected && !stopping;
        res.writeHead(ok ? 200 : 503);
        res.end(JSON.stringify({ ok }));
      });
      await new Promise((resolve, reject) => { health.once('error', reject); health.listen(config.port, '0.0.0.0', resolve); });
      health.on('error', error => { logError('health', error); void stop(1); });
    }
    if (stopping) return;
    ready = true;
    console.log('Telepass آماده است. از اکانت ادمین به این اکانت /menu بفرستید.');
  } catch (error) {
    console.error(error instanceof UserError ? error.message : friendlyError(error));
    await stop(1);
  }
}
main().catch(error => { console.error(error instanceof UserError ? error.message : friendlyError(error)); process.exitCode = 1; });
