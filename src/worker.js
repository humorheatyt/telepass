import { Api } from 'teleproto';
import bigInt from 'big-integer';
import { inputPeer } from './peers.js';
import { errorCode, logError } from './errors.js';

const PERMANENT = /^(CHAT_FORWARDS_RESTRICTED|CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED|CHANNEL_PRIVATE|CHANNEL_INVALID|PEER_ID_INVALID|USER_IS_BLOCKED|INPUT_USER_DEACTIVATED|MESSAGE_ID_INVALID|MSG_ID_INVALID|MESSAGE_EMPTY|TOPIC_CLOSED|USER_BANNED_IN_CHANNEL)$/;

export class ForwardWorker {
  constructor(client, store, { now = Date.now, interval = 1200 } = {}) {
    this.client = client; this.store = store; this.now = now; this.interval = interval;
    this.running = false; this.busy = null;
  }
  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      this.busy = this.tick().catch(error => logError('queue', error));
      await this.busy;
      this.busy = null;
      if (this.running) this.timer = setTimeout(loop, this.interval);
    };
    void loop();
  }
  async stop() { this.running = false; clearTimeout(this.timer); await this.busy; }
  async tick() {
    if (this.store.get('paused') === '1' || !this.client.connected) return;
    if (Number(this.store.get('forward_not_before', '0')) > this.now()) return;
    const job = this.store.nextJob();
    if (!job || job.next_at > this.now()) return;
    try {
      // Raw RPC lets us persist random_id. A retry after a crash uses the SAME
      // random_id, allowing Telegram to deduplicate an already accepted send.
      await this.client.invoke(new Api.messages.ForwardMessages({
        fromPeer: inputPeer(this.store.peer(job.source)),
        toPeer: inputPeer(this.store.peer(job.destination)),
        id: [job.message_id], randomId: [bigInt(job.random_id)]
      }));
      this.store.done(job.id, this.now());
    } catch (error) {
      const code = errorCode(error);
      const seconds = Number(error.seconds);
      if (Number.isFinite(seconds) && seconds > 0) {
        const nextAt = this.now() + (seconds + 2) * 1000;
        // A Telegram wait applies even if the triggering job is deleted. Keep
        // the deadline independently of the queue, including across restarts.
        this.store.transaction(() => {
          this.store.set('forward_not_before', nextAt);
          this.store.retry(job.id, nextAt, code, false);
        });
      } else if (PERMANENT.test(code) || job.attempts >= 9) {
        this.store.fail(job.id, code);
        logError('forward_failed', error);
      } else {
        this.store.retry(job.id, this.now() + Math.min(300000, 2000 * 2 ** job.attempts), code);
      }
    }
  }
}
