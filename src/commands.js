import { adminTextChunks, normalizeDigits } from './admin-text.js';
import { CustomFile } from 'teleproto/client/uploads.js';
import { exportData, importData, sampleData, MAX_JSON_BYTES } from './backup.js';
import { ADMIN_ID } from './config.js';
import { isAdminMessage } from './filter.js';
import { describe, inputPeer } from './peers.js';
import { UserError, friendlyError } from './errors.js';

const MENU = `Telepass Admin Menu
1 — Status
2 — Sources
3 — Whitelist
4 — Destination
5 — Pause / Resume
6 — Queue & Errors
7 — Command Help
8 — JSON data backup
0 — Main menu: /menu | /cancel — Cancel input`;
const HELP = `Admin commands (send each command as a separate message):
/source list [PAGE]
/source add REF
/source remove ID
/allow list [PAGE]
/allow add REF
/allow remove RULE_NUMBER
/rule RULE_NUMBER|all forwards on|off
/rule RULE_NUMBER|all replies on|off
/destination set REF
/destination show
/join LINK_OR_USERNAME
/sync
/linked REF
/data export
/data sample
/data import merge|replace confirm
/pause | /resume
/status | /errors
/queue clear confirm
/menu | /help | /cancel

REF: @username, a t.me link, an invite link, or a known numeric ID.
To monitor a channel as a sender, add it both as a source and to the whitelist.
Rule numbers are shown by /allow list.
forwards: allow messages that were forwarded to the sender? Default: on.
replies: also forward the original message replied to? Default: off.
Each whitelist rule has independent forwards and replies settings.
Use all instead of a rule number to update all existing rules (not future rules).
Anonymous owners/admins cannot be identified individually: whitelist their GROUP.
/linked GROUP_REF discovers its linked channel (or the reverse).
For discussion posts: source = group, whitelist = linked channel; forwards must be on.
/data import requires /pause, then upload a JSON document within 5 minutes.
Merge updates/adds entries; replace deletes existing database contents.
Exports include jobs/history and access hashes, NOT login sessions or environment secrets.
Sample IDs/hashes are fake: edit them before using. Keep backups private.
Groups can be whitelisted for anonymous-admin / send-as-group messages.
Adding a source does not join it; use /join first.
Pausing stops both new message intake and queued delivery.`;

function number(value) {
  if (!/^\d+$/.test(value || '') || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new UserError('Enter a valid positive number.');
  return Number(value);
}
function page(items, value, render, command) {
  const p = value ? number(value) : 1;
  const pages = Math.max(1, Math.ceil(items.length / 12));
  if (p > pages) throw new UserError(`Page count: ${pages}`);
  return (items.slice((p - 1) * 12, p * 12).map(render).join('\n\n') || 'List is empty.') + `\n\nPage ${p}/${pages} — ${command} PAGE`;
}

export class Commands {
  constructor(client, store, peers) {
    this.client = client; this.store = store; this.peers = peers;
    this.pending = null; this.busy = false;
  }
  async reply(text, target = ADMIN_ID) {
    // Explicit code entities make commands copyable without parsing user content.
    for (const chunk of adminTextChunks(text)) {
      await this.client.sendMessage(target, { ...chunk, parseMode: false, linkPreview: false });
    }
  }
  async handle(message) {
    if (!isAdminMessage(message) || this.busy) return;
    this.busy = true;
    // Use the actual incoming InputPeer; an admin ID alone may lack access_hash.
    let target = ADMIN_ID;
    try {
      target = await message.getInputSender().catch(() => null) || ADMIN_ID;
      let text = normalizeDigits(String(message.message || '').trim());
      if (!this.pending?.prefix) text = ({ '81': '/data export', '82': '/data sample' })[text] || text;
      if (message.document) {
        if (!this.pending?.importMode || Date.now() > this.pending.expires) {
          this.pending = null;
          throw new UserError('First use /data import merge|replace confirm; then upload the JSON document within 5 minutes.');
        }
        const mode = this.pending.importMode;
        this.pending = null;
        if (this.store.get('paused') !== '1') throw new UserError('Use /pause before importing.');
        if (BigInt(message.document.size ?? MAX_JSON_BYTES + 1) > BigInt(MAX_JSON_BYTES)) throw new UserError('Maximum JSON size is 8 MiB.');
        const buffer = await this.client.downloadMedia(message);
        if (!Buffer.isBuffer(buffer) || buffer.length > MAX_JSON_BYTES) throw new UserError('Could not download a valid JSON document (8 MiB maximum).');
        await this.beforeImport?.();
        await this.reply(importData(this.store, buffer.toString('utf8'), mode), target);
        return;
      }
      if (!text || text.length > 2048) return;
      if (['/data export', '/data sample'].includes(text)) {
        const sample = text === '/data sample';
        const buffer = Buffer.from(JSON.stringify(sample ? sampleData() : exportData(this.store), null, 2));
        await this.client.sendFile(target, {
          file: new CustomFile(sample ? 'telepass-sample.json' : 'telepass-backup.json', buffer.length, '', buffer),
          forceDocument: true, caption: sample ? 'TEST DATA ONLY: replace fake IDs and access hashes before importing.' : 'Private database backup. Login session and environment secrets are not included.'
        });
        return;
      }
      const response = await this.execute(text);
      if (response) await this.reply(response, target || ADMIN_ID);
    } catch (error) {
      await this.reply(error instanceof UserError ? error.message : friendlyError(error), target || ADMIN_ID);
    } finally { this.busy = false; }
  }
  prompt(prefix, text) {
    this.pending = { prefix, expires: Date.now() + 300000 };
    return `${text}\n/cancel to cancel; expires in 5 minutes.`;
  }
  async execute(raw) {
    let text = normalizeDigits(raw);
    if (text === '/cancel') { this.pending = null; return 'Input cancelled.\n' + MENU; }
    if (['/start', '/menu', '0'].includes(text)) { this.pending = null; return MENU; }
    if (!text.startsWith('/') && this.pending?.prefix) {
      const pending = this.pending; this.pending = null;
      if (Date.now() > pending.expires) throw new UserError('Input expired. Please select an option from the menu again.');
      text = `${pending.prefix} ${text}`;
    }
    const menus = {
      '1': '/status', '2': '/sources-menu', '3': '/allow-menu', '4': '/destination-menu',
      '5': this.store.get('paused') === '1' ? '/resume' : '/pause', '6': '/queue-menu', '7': '/help', '8': '/data-menu',
      '21': '/source list', '25': '/sync', '31': '/allow list', '41': '/destination show', '61': '/errors',
      '85': '/pause', '86': '/resume'
    };
    text = menus[text] || text;
    const prompts = {
      '22': ['/source add', 'Send the source link or ID.'],
      '23': ['/source remove', 'Send the full source ID from the list (for example, -1001234567890).'],
      '24': ['/join', 'Send the invite link or username to join.'],
      '26': ['/linked', 'Send the group or channel link or ID to find its linked chat.'],
      '32': ['/allow add', 'Send the link or ID of the allowed person, group, or channel.'],
      '33': ['/allow remove', 'Send the rule number shown in the whitelist.'],
      '34': ['/rule', 'Send the rule number, setting, and value; for example: 1 forwards off or 1 replies on.'],
      '42': ['/destination set', 'Send the destination link or ID.'],
      '62': ['/queue clear', 'WARNING: pending jobs will be deleted. Send confirm to clear the queue.'],
      '83': ['/data import merge', 'Send confirm to update/add data, then upload the JSON document.'],
      '84': ['/data import replace', 'WARNING: ALL database data will be replaced. Send confirm, then upload the JSON document.']
    };
    if (['83', '84'].includes(text) && this.store.get('paused') !== '1') {
      throw new UserError('Use /pause or select 85 before choosing an import option.');
    }
    if (prompts[text]) return this.prompt(...prompts[text]);
    const [cmd, ...args] = text.split(/\s+/);
    if (cmd === '/data-menu') return 'JSON data\n81 — Download database backup: /data export\n82 — Download test structure: /data sample\n83 — Import merge (confirmation required): /data import merge confirm\n84 — Import replace ALL data (confirmation required): /data import replace confirm\n85 — Pause: /pause\n86 — Resume: /resume\nPause before importing. After import, check configuration before resuming.\n0 — Main menu: /menu';
    if (cmd === '/data' && args[0] === 'import' && args.length === 3 && ['merge', 'replace'].includes(args[1]) && args[2] === 'confirm') {
      if (this.store.get('paused') !== '1') throw new UserError('Use /pause before importing.');
      this.pending = { importMode: args[1], expires: Date.now() + 300000 };
      return `Upload the JSON document within 5 minutes. Mode: ${args[1]}. ${args[1] === 'replace' ? 'WARNING: all current database data will be replaced.' : 'Existing records are updated; new records are added. Existing jobs are not replayed.'} /cancel to cancel.`;
    }
    if (cmd === '/linked' && args.length === 1) {
      const peer = await this.peers.linked(args[0]);
      return `Linked chat found (nothing automatically enabled):\n${describe(peer)}\nFor discussion messages, add the GROUP as /source add GROUP_ID and the CHANNEL as /allow add CHANNEL_ID. Keep forwards on for the channel rule. For anonymous admins, /allow add GROUP_ID; Telegram hides their individual identity. Join the group first if needed.`;
    }
    if (cmd === '/help'  && !args.length) return HELP;
    if (cmd === '/sources-menu') return 'Sources\n21 — List sources: /source list\n22 — Add source: /source add REF\n23 — Remove source: /source remove ID\n24 — Join a group/channel: /join LINK_OR_USERNAME\n25 — Sync known IDs: /sync\n26 — Find linked chat: /linked REF\n0 — Main menu: /menu';
    if (cmd === '/allow-menu') return 'Whitelist\n31 — List rules: /allow list\n32 — Add whitelist entry: /allow add REF\n33 — Remove rule: /allow remove RULE_NUMBER\n34 — Change forwards / replies (rule number or all)\n/rule RULE_NUMBER|all forwards on|off\n/rule RULE_NUMBER|all replies on|off\n0 — Main menu: /menu';
    if (cmd === '/destination-menu') return 'Destination\n41 — Show destination: /destination show\n42 — Set destination: /destination set REF\n0 — Main menu: /menu';
    if (cmd === '/queue-menu') return `Pending jobs: ${this.store.pendingCount()}\n61 — Recent errors: /errors\n62 — Clear queue (confirmation required): /queue clear confirm\n0 — Main menu: /menu`;
    if (cmd === '/status' && !args.length) {
      const destination = this.store.peer(this.store.get('destination'));
      return `Status: ${this.store.get('paused') === '1' ? 'Paused' : 'Running'}\nConnection: ${this.client.connected ? 'Connected' : 'Disconnected'}\nSources: ${this.store.sources().length} | Whitelist rules: ${this.store.rules().length}\nQueue: ${this.store.pendingCount()} / 5000\nEvents rejected because the queue was full: ${this.store.get('overflow_events', '0')}\nRAM usage: ${Math.round(process.memoryUsage().rss / 1048576)} MB\nProcess uptime: ${Math.floor(process.uptime() / 60)} minutes\nDestination: ${destination ? describe(destination) : 'Not set'}\n${this.store.stats().map(s => `${s.status}: ${s.n}`).join(' | ')}\nDelivery errors: /errors`;
    }
    if (['/pause', '/resume'].includes(cmd) && !args.length) {
      this.store.set('paused', cmd === '/pause' ? '1' : '0');
      return cmd === '/pause' ? 'New message intake and queued delivery are paused. Messages received during this period will not be replayed. An in-progress delivery may still finish.' : 'Message intake and delivery resumed.';
    }
    if (cmd === '/source') {
      const [action, ref] = args;
      if (action === 'list' && args.length <= 2) return page(this.store.sources(), ref, describe, '/source list');
      if (action === 'add' && args.length === 2) {
        const { peer, entity } = await this.peers.resolve(ref);
        if (entity.left || entity.kicked) throw new UserError('The account is not a member of this source. Join it first with /join REF.');
        this.store.addSource(peer.id);
        return `Source added:\n${describe(peer)}`;
      }
      if (action === 'remove' && args.length === 2) {
        if (!this.store.hasSource(ref)) throw new UserError('This ID is not in the source list.');
        this.store.removeSource(ref);
        return 'Source and its pending jobs removed. An in-progress delivery may still finish.';
      }
    }
    if (cmd === '/allow') {
      const [action, ref] = args;
      if (action === 'list' && args.length <= 2) return page(this.store.rules(), ref, r => `Rule #${r.id}\n${describe(r)}\nforwards: ${r.forwards ? 'on' : 'off'} | replies: ${r.replies ? 'on' : 'off'}`, '/allow list');
      if (action === 'add' && args.length === 2) {
        const { peer } = await this.peers.resolve(ref);
        const rule = this.store.addRule(peer.id);
        return `Whitelist rule #${rule.id} added:\n${describe(peer)}\nforwards: ${rule.forwards ? 'on' : 'off'} | replies: ${rule.replies ? 'on' : 'off'}`;
      }
      if (action === 'remove' && args.length === 2) {
        this.store.removeRule(number(ref));
        return 'Whitelist rule and its pending jobs removed. An in-progress delivery may still finish.';
      }
    }
    if (cmd === '/rule' && args.length === 3) {
      if (!['on', 'off'].includes(args[2])) throw new UserError('Value must be on or off.');
      if (args[0] === 'all') this.store.toggleAll(args[1], args[2] === 'on');
      else this.store.toggle(number(args[0]), args[1], args[2] === 'on');
      return `${args[0] === 'all' ? 'All existing rules' : `Rule #${args[0]}`}: ${args[1]} = ${args[2]}\nThis affects future messages; jobs already in the queue are unchanged.`;
    }
    if (cmd === '/destination') {
      if (args[0] === 'show' && args.length === 1) {
        const p = this.store.peer(this.store.get('destination'));
        return p ? describe(p) : 'Destination is not set.';
      }
      if (args[0] === 'set' && args.length === 2) {
        const { peer, entity } = await this.peers.resolve(args[1]);
        if (this.store.hasSource(peer.id)) throw new UserError('The destination cannot also be a source.');
        if (peer.kind === 'channel' && !entity.creator && !entity.adminRights?.postMessages) throw new UserError('The account must have permission to post in the destination channel.');
        if (this.store.pendingCount() && this.store.get('destination') !== peer.id) throw new UserError('Drain the queue first, or clear it with /queue clear confirm.');
        // A real test is more reliable than checking cached permission flags.
        await this.reply('Telepass: This chat has been selected as the forwarding destination.', inputPeer(peer));
        this.store.setDestination(peer.id);
        return `Destination saved and test message sent successfully:\n${describe(peer)}`;
      }
    }
    if (cmd === '/join' && args.length === 1) {
      const { peer } = await this.peers.resolve(args[0], { join: true });
      return `Joined successfully. Add it as a source with /source add:\n${describe(peer)}`;
    }
    if (cmd === '/sync' && !args.length) return `Saved ${await this.peers.sync()} IDs from recent dialogs (up to 200).`;
    if (cmd === '/errors' && !args.length) return this.store.errors().map(e => `#${e.id} | ${e.source}/${e.message_id} | ${e.error}`).join('\n') || 'No delivery errors recorded.';
    if (cmd === '/queue' && args.join(' ') === 'clear confirm') return `Cleared ${this.store.clearPending()} pending jobs. An in-progress delivery may still finish.`;
    throw new UserError('Invalid command. Send /menu or /help.');
  }
}
