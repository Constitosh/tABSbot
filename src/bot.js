// src/bot.js
import './configEnv.js';
import { Telegraf } from 'telegraf';
import { getJSON, setJSON } from './cache.js';
import { queue, refreshToken } from './queueCore.js';
import { renderOverview, renderBuyers, renderHolders, renderAbout } from './renderers.js';
import { isAddress } from './util.js';

// PNL imports (queue optional; see notes below)
import { refreshPnl } from './pnlWorker.js'; // ⬅ only refreshPnl to avoid export mismatch
import { renderPNL } from './renderers_pnl.js';

import { getIndexSnapshot, buildIndexSnapshot } from './indexer.js';
import { renderIndexView } from './renderers_index.js';


// --- Bot with longer handler timeout + global error catcher ---
const bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: 15_000 });

bot.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error('[TG] middleware error:', err?.response?.description || err);
  }
});

bot.catch((err, ctx) => {
  console.error('[TG] Global bot.catch error on update', ctx.updateType, err?.response?.description || err);
});

// ----- HTML helpers -----
const sendHTML = (ctx, text, extra = {}) =>
  ctx.replyWithHTML(text, { disable_web_page_preview: true, ...extra });

// Safe edit: ignore “message is not modified”
const editHTML = async (ctx, text, extra = {}) => {
  try {
    return await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (err) {
    const desc = err?.response?.description || '';
    if (desc.includes('message is not modified')) {
      try { await ctx.answerCbQuery('Already up to date'); } catch {}
      return;
    }
    throw err;
  }
};

// ----- Data helpers -----
async function ensureData(ca) {
  try {
    const key = `token:${ca}:summary`;
    const cache = await getJSON(key);
    if (cache) return cache;

    // cold start: try a synchronous refresh once
    const fresh = await refreshToken(ca);
    return fresh || null;
  } catch (e) {
    // enqueue and ask user to retry
    try {
      await queue.add('refresh', { tokenAddress: ca }, { removeOnComplete: true, removeOnFail: true });
    } catch (_) {}
    return null;
  }
}

async function ensureIndex(ca) {
  const key = `index:${ca}`;
  const cached = await getJSON(key);
  if (cached) return cached;
  const snap = await buildIndexSnapshot(ca);
  await setJSON(key, snap, 6 * 60 * 60);
  return snap;
}

// Always return { ok:boolean, age?:number, error?:string }
async function requestRefresh(ca) {
  try {
    const last = await getJSON(`token:${ca}:last_refresh`);
    const age = last ? (Date.now() - last.ts) / 1000 : Infinity;

    if (Number.isFinite(age) && age < 30) {
      return { ok: false, age };
    }

    await setJSON(`token:${ca}:last_refresh`, { ts: Date.now() }, 600);
    await queue.add('refresh', { tokenAddress: ca }, { removeOnComplete: true, removeOnFail: true });

    return { ok: true, age: Number.isFinite(age) ? age : null };
  } catch (e) {
    return { ok: false, error: e?.message || 'enqueue failed' };
  }
}

// ----- Commands -----
bot.start((ctx) =>
  ctx.reply(
    [
      'tABS Tools ready.',
      'Use /stats <contract>  •  /refresh <contract>  •  /pnl <wallet>',
      'Example: /stats 0x1234567890abcdef1234567890abcdef12345678',
      'Example: /pnl   0x1234567890abcdef1234567890abcdef12345678',
    ].join('\n')
  )
);

// /stats <ca>
bot.command('stats', async (ctx) => {
  const [, caRaw] = (ctx.message?.text || '').trim().split(/\s+/);
  if (!isAddress(caRaw)) return ctx.reply('Send: /stats <contractAddress>');

  const ca = caRaw.toLowerCase();
  const data = await ensureData(ca);
  if (!data) return ctx.reply('Initializing… try again in a few seconds.');

  const { text, extra } = renderOverview(data);
  return sendHTML(ctx, text, extra);
});

// /refresh <ca>
bot.command('refresh', async (ctx) => {
  const [, caRaw] = (ctx.message?.text || '').trim().split(/\s+/);
  if (!isAddress(caRaw)) return ctx.reply('Send: /refresh <contractAddress>');

  const ca = caRaw.toLowerCase();
  const res = await requestRefresh(ca);

  if (!res.ok) {
    if (typeof res.age === 'number') {
      return ctx.reply(`Recently refreshed (${res.age.toFixed(0)}s ago). Try again shortly.`);
    }
    return ctx.reply(`Couldn't queue refresh. ${res.error ? 'Error: ' + res.error : ''}`);
  }
  return ctx.reply(`Refreshing ${ca}…`);
});

// ----- PNL command (default: 30d, overview) -----
bot.command('pnl', async (ctx) => {
  try {
    const parts = (ctx.message?.text || '').trim().split(/\s+/);
    const wallet = (parts[1] || '').toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
      return ctx.reply('Usage: /pnl <walletAddress>');
    }

    // Optional queue: uncomment if your pnlWorker exports `pnlQueue`
    // try { await pnlQueue.add('pnl', { wallet, window: '30d' }, { removeOnComplete: true, removeOnFail: true }); } catch {}

    const data = await refreshPnl(wallet, '30d'); // window: 24h|7d|30d|90d|all
    const { text, extra } = renderPNL(data, '30d', 'overview');
    return ctx.replyWithHTML(text, extra);
  } catch (e) {
    console.error('[PNL /pnl] error:', e?.message || e);
    return ctx.reply('PNL: something went wrong.');
  }
});

/* ====== Callback handlers ====== */

// noop buttons: just close the spinner
bot.action('noop', (ctx) => ctx.answerCbQuery(''));

// Main action router for stats/buyers/holders/refresh
bot.action(/^(stats|buyers|holders|refresh|index):/, async (ctx) => {
  const dataStr = ctx.callbackQuery?.data || '';
  try {
    // ack asap
    try { await ctx.answerCbQuery('Working…'); } catch {}

    const [kind, ca, maybePage] = dataStr.split(':');

    if (kind === 'refresh') {
      const res = await requestRefresh(ca);
      const msg = res.ok
        ? 'Refreshing…'
        : (typeof res.age === 'number'
            ? `Recently refreshed (${res.age.toFixed(0)}s ago). Try again shortly.`
            : `Couldn't queue refresh${res.error ? `: ${res.error}` : ''}`);
      try { await ctx.answerCbQuery(msg, { show_alert: false }); } catch {}
      return;
    }

    const data = await ensureData(ca);
    if (!data) {
      try { await ctx.answerCbQuery('Initializing… try again shortly.', { show_alert: true }); } catch {}
      return;
    }

    if (kind === 'stats') {
      const { text, extra } = renderOverview(data);
      await editHTML(ctx, text, extra);
      return;
    }

    if (kind === 'buyers') {
      const page = Number(maybePage || 1);
      const { text, extra } = renderBuyers(data, page);
      await editHTML(ctx, text, extra);
      return;
    }

    if (kind === 'holders') {
      const page = Number(maybePage || 1);
      const { text, extra } = renderHolders(data, page);
      await editHTML(ctx, text, extra);
      return;
    }
  } catch (e) {
    console.error('[stats/buyers/holders cb] error:', e?.response?.description || e);
    try { await ctx.answerCbQuery('Error — try again', { show_alert: true }); } catch {}
  }
});

// ----- PNL callbacks (windows / views / refresh) -----
// Supports:
//   pnlv:<wallet>:<window>:<view>    (view ∈ overview|profits|losses|open|airdrops)
//   pnl:<wallet>:<window>            (legacy window-only -> overview)
//   pnl_refresh:<wallet>:<window>
bot.on('callback_query', async (ctx) => {
  const d = ctx.callbackQuery?.data || '';
  try {
    // ACK immediately so Telegram doesn't expire the callback
    try { await ctx.answerCbQuery('Working…'); } catch {}

    if (d.startsWith('pnlv:')) {
      const [, wallet, window, view] = d.split(':');
      const data = await refreshPnl(wallet, window);
      const { text, extra } = renderPNL(data, window, view);
      await ctx.editMessageText(text, { ...extra, parse_mode: 'HTML', disable_web_page_preview: true });
      return;
    }

    if (d.startsWith('pnl:')) {
      const [, wallet, window] = d.split(':');
      const data = await refreshPnl(wallet, window);
      const { text, extra } = renderPNL(data, window, 'overview');
      await ctx.editMessageText(text, { ...extra, parse_mode: 'HTML', disable_web_page_preview: true });
      return;
    }

    if (d.startsWith('pnl_refresh:')) {
      const [, wallet, window] = d.split(':');

      // Optional queue: uncomment if your pnlWorker exports `pnlQueue`
      // try { await pnlQueue.add('pnl', { wallet, window }, { removeOnComplete: true, removeOnFail: true }); } catch {}

      const data = await refreshPnl(wallet, window);
      const { text, extra } = renderPNL(data, window, 'overview');
      await ctx.editMessageText(text, { ...extra, parse_mode: 'HTML', disable_web_page_preview: true });
      try { await ctx.answerCbQuery('Refreshed'); } catch {}
      return;
    }

    // ignore other callback routes here (handled above)
  } catch (e) {
    console.error('[PNL cb] error:', e?.response?.description || e);
    try { await ctx.answerCbQuery('Error'); } catch {}
  }
});

// ----- Boot -----
bot.launch().then(() => console.log('tABS Tools bot up.'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
