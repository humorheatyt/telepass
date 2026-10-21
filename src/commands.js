import { ADMIN_ID } from './config.js';
import { isAdminMessage } from './filter.js';
import { describe, inputPeer } from './peers.js';
import { UserError, friendlyError } from './errors.js';

const MENU = `مدیریت Telepass — فقط ادمین
۱ / 1 — وضعیت
۲ / 2 — مبدأها
۳ / 3 — وایت‌لیست
۴ / 4 — مقصد
۵ / 5 — توقف/ادامه
۶ / 6 — صف و خطاها
۷ / 7 — راهنمای دستورها
/menu بازگشت | /cancel لغو ورودی`;
const HELP = `دستورهای مدیریت (هر دستور یک پیام):
/source list [PAGE]
/source add REF
/source remove ID
/allow list [PAGE]
/allow add REF
/allow remove RULE_NUMBER
/rule RULE_NUMBER forwards on|off
/rule RULE_NUMBER replies on|off
/destination set REF
/destination show
/join LINK_OR_USERNAME
/sync
/pause | /resume
/status | /errors
/queue clear confirm
/menu | /help | /cancel

REF: @username، لینک t.me، لینک دعوت یا ID شناخته‌شده.
برای کانال: هم کانال را مبدأ و هم در وایت‌لیست ثبت کنید.
شمارهٔ قانون در /allow list نمایش داده می‌شود.
forwards: پیام از قبل فورواردشده از این فرستنده ارسال شود؟ پیش‌فرض روشن.
replies: اصل پیامی که شخص به آن پاسخ داده هم ارسال شود؟ پیش‌فرض خاموش.
گزینهٔ replies فقط برای اشخاص است. گزینه‌ها با on/off تغییر می‌کنند.
عضویت خودکار با add انجام نمی‌شود؛ ابتدا /join بفرستید.
توقف، هم دریافت جدید و هم ارسال صف را متوقف می‌کند.`;

function number(value) {
  if (!/^\d+$/.test(value || '') || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new UserError('عدد مثبت معتبر وارد کنید.');
  return Number(value);
}
function page(items, value, render, command) {
  const p = value ? number(value) : 1;
  const pages = Math.max(1, Math.ceil(items.length / 12));
  if (p > pages) throw new UserError(`تعداد صفحه‌ها: ${pages}`);
  return (items.slice((p - 1) * 12, p * 12).map(render).join('\n\n') || 'لیست خالی است.') + `\n\nصفحه ${p}/${pages} — ${command} PAGE`;
}

export class Commands {
  constructor(client, store, peers) {
    this.client = client; this.store = store; this.peers = peers;
    this.pending = null; this.busy = false;
  }
  async reply(text, target = ADMIN_ID) {
    // Text only. Names/references cannot inject formatting or link previews.
    for (let i = 0; i < text.length; i += 3500) {
      await this.client.sendMessage(target, { message: text.slice(i, i + 3500), parseMode: false, linkPreview: false });
    }
  }
  async handle(message) {
    if (!isAdminMessage(message) || this.busy) return;
    this.busy = true;
    // Use the actual incoming InputPeer; an admin ID alone may lack access_hash.
    let target = ADMIN_ID;
    try {
      target = await message.getInputSender().catch(() => null) || ADMIN_ID;
      const text = String(message.message || '').trim();
      if (!text || text.length > 2048) return;
      const response = await this.execute(text);
      if (response) await this.reply(response, target || ADMIN_ID);
    } catch (error) {
      await this.reply(error instanceof UserError ? error.message : friendlyError(error), target || ADMIN_ID);
    } finally { this.busy = false; }
  }
  prompt(prefix, text) {
    this.pending = { prefix, expires: Date.now() + 300000 };
    return `${text}\n/cancel برای لغو؛ مهلت ۵ دقیقه.`;
  }
  async execute(raw) {
    let text = raw.replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
    if (text === '/cancel') { this.pending = null; return 'ورودی لغو شد.\n' + MENU; }
    if (['/start', '/menu', '0'].includes(text)) { this.pending = null; return MENU; }
    if (!text.startsWith('/') && this.pending) {
      const pending = this.pending; this.pending = null;
      if (Date.now() > pending.expires) throw new UserError('مهلت ورودی تمام شد؛ دوباره از منو انتخاب کنید.');
      text = `${pending.prefix} ${text}`;
    }
    const menus = {
      '1': '/status', '2': '/sources-menu', '3': '/allow-menu', '4': '/destination-menu',
      '5': this.store.get('paused') === '1' ? '/resume' : '/pause', '6': '/queue-menu', '7': '/help',
      '21': '/source list', '31': '/allow list', '41': '/destination show', '61': '/errors'
    };
    text = menus[text] || text;
    const prompts = {
      '22': ['/source add', 'لینک یا شناسهٔ مبدأ را بفرستید.'],
      '23': ['/source remove', 'ID کامل مبدأ از فهرست را بفرستید (مثلاً -1001234567890).'],
      '32': ['/allow add', 'لینک یا شناسهٔ شخص/کانال مجاز را بفرستید.'],
      '33': ['/allow remove', 'شمارهٔ قانون را از فهرست وایت‌لیست بفرستید.'],
      '34': ['/rule', 'شماره قانون، گزینه و مقدار را بفرستید؛ مثلاً: 1 forwards off یا 1 replies on'],
      '42': ['/destination set', 'لینک یا شناسهٔ مقصد را بفرستید.']
    };
    if (prompts[text]) return this.prompt(...prompts[text]);
    const [cmd, ...args] = text.split(/\s+/);
    if (cmd === '/help' && !args.length) return HELP;
    if (cmd === '/sources-menu') return 'مبدأها\n21 — نمایش\n22 — افزودن\n23 — حذف\n/menu — منوی اصلی';
    if (cmd === '/allow-menu') return 'وایت‌لیست\n31 — نمایش قوانین\n32 — افزودن\n33 — حذف\n34 — تغییر forwards / replies\n/menu — منوی اصلی';
    if (cmd === '/destination-menu') return 'مقصد\n41 — نمایش\n42 — تنظیم مقصد\n/menu — منوی اصلی';
    if (cmd === '/queue-menu') return `صف منتظر: ${this.store.pendingCount()}\n61 — خطاهای اخیر\nبرای پاک کردن صف: /queue clear confirm\n/menu — منوی اصلی`;
    if (cmd === '/status' && !args.length) {
      const destination = this.store.peer(this.store.get('destination'));
      return `وضعیت: ${this.store.get('paused') === '1' ? 'متوقف' : 'فعال'}\nاتصال: ${this.client.connected ? 'برقرار' : 'قطع'}\nمبدأ: ${this.store.sources().length} | قانون: ${this.store.rules().length}\nصف: ${this.store.pendingCount()} / 5000\nرویداد ردشده به‌علت پر بودن صف: ${this.store.get('overflow_events', '0')}\nمصرف RAM: ${Math.round(process.memoryUsage().rss / 1048576)} MB\nمدت اجرای پردازش: ${Math.floor(process.uptime() / 60)} دقیقه\nمقصد: ${destination ? describe(destination) : 'تنظیم نشده'}\n${this.store.stats().map(s => `${s.status}: ${s.n}`).join(' | ')}\nخطاهای ارسال: /errors`;
    }
    if (['/pause', '/resume'].includes(cmd) && !args.length) {
      this.store.set('paused', cmd === '/pause' ? '1' : '0');
      return cmd === '/pause' ? 'دریافت جدید و ارسال صف متوقف شد. پیام‌های این بازه بازخوانی نمی‌شوند. ارسال در حال اجرا ممکن است تمام شود.' : 'دریافت و ارسال ادامه یافت.';
    }
    if (cmd === '/source') {
      const [action, ref] = args;
      if (action === 'list' && args.length <= 2) return page(this.store.sources(), ref, describe, '/source list');
      if (action === 'add' && args.length === 2) {
        const { peer, entity } = await this.peers.resolve(ref);
        if (entity.left || entity.kicked) throw new UserError('اکانت عضو این مبدأ نیست؛ ابتدا /join REF را اجرا کنید.');
        this.store.addSource(peer.id);
        return `مبدأ ثبت شد:\n${describe(peer)}`;
      }
      if (action === 'remove' && args.length === 2) {
        if (!this.store.hasSource(ref)) throw new UserError('این ID در فهرست مبدأ نیست.');
        this.store.removeSource(ref);
        return 'مبدأ و کارهای منتظر آن حذف شدند؛ ارسال در حال اجرا ممکن است تمام شود.';
      }
    }
    if (cmd === '/allow') {
      const [action, ref] = args;
      if (action === 'list' && args.length <= 2) return page(this.store.rules(), ref, r => `قانون #${r.id}\n${describe(r)}\nforwards: ${r.forwards ? 'on' : 'off'} | replies: ${r.replies ? 'on' : 'off'}`, '/allow list');
      if (action === 'add' && args.length === 2) {
        const { peer } = await this.peers.resolve(ref);
        const rule = this.store.addRule(peer.id);
        return `قانون #${rule.id} ثبت شد:\n${describe(peer)}\nforwards: ${rule.forwards ? 'on' : 'off'} | replies: ${rule.replies ? 'on' : 'off'}`;
      }
      if (action === 'remove' && args.length === 2) {
        this.store.removeRule(number(ref));
        return 'قانون و کارهای منتظر آن حذف شدند؛ ارسال در حال اجرا ممکن است تمام شود.';
      }
    }
    if (cmd === '/rule' && args.length === 3) {
      if (!['on', 'off'].includes(args[2])) throw new UserError('مقدار باید on یا off باشد.');
      this.store.toggle(number(args[0]), args[1], args[2] === 'on');
      return `قانون #${args[0]}: ${args[1]} = ${args[2]}\nتغییر برای پیام‌های بعدی است؛ کارهای فعلی صف تغییر نمی‌کنند.`;
    }
    if (cmd === '/destination') {
      if (args[0] === 'show' && args.length === 1) {
        const p = this.store.peer(this.store.get('destination'));
        return p ? describe(p) : 'مقصد تنظیم نشده است.';
      }
      if (args[0] === 'set' && args.length === 2) {
        const { peer, entity } = await this.peers.resolve(args[1]);
        if (this.store.hasSource(peer.id)) throw new UserError('مقصد نباید از مبدأها باشد.');
        if (peer.kind === 'channel' && !entity.creator && !entity.adminRights?.postMessages) throw new UserError('اکانت در کانال مقصد باید مجوز ارسال پست داشته باشد.');
        if (this.store.pendingCount() && this.store.get('destination') !== peer.id) throw new UserError('ابتدا صف را تخلیه یا با /queue clear confirm پاک کنید.');
        // A real test is more reliable than checking cached permission flags.
        await this.reply('Telepass: این گفتگو به‌عنوان مقصد فوروارد انتخاب شد.', inputPeer(peer));
        this.store.setDestination(peer.id);
        return `مقصد ثبت و ارسال آزمایشی موفق شد:\n${describe(peer)}`;
      }
    }
    if (cmd === '/join' && args.length === 1) {
      const { peer } = await this.peers.resolve(args[0], { join: true });
      return `عضویت انجام شد؛ برای رصد با /source add اضافه کنید:\n${describe(peer)}`;
    }
    if (cmd === '/sync' && !args.length) return `شناسه‌های ${await this.peers.sync()} گفتگوی اخیر ذخیره شد (حداکثر ۲۰۰).`;
    if (cmd === '/errors' && !args.length) return this.store.errors().map(e => `#${e.id} | ${e.source}/${e.message_id} | ${e.error}`).join('\n') || 'خطای ارسال ثبت نشده است.';
    if (cmd === '/queue' && args.join(' ') === 'clear confirm') return `${this.store.clearPending()} کار منتظر پاک شد؛ ارسال در حال اجرا ممکن است تمام شود.`;
    throw new UserError('دستور نامعتبر است. /menu یا /help را بفرستید.');
  }
}
