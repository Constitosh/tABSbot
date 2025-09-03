// src/bot.js
import './configEnv.js';
import { Telegraf } from 'telegraf';
import { getJSON, setJSON } from './cache.js';
import { queue, refreshToken } from './queueCore.js';
import { renderOverview, renderBuyers, renderHolders, renderAbout } from './renderers.js';
import { isAddress } from './util.js';

// PNL imports
import { pnlQueue, refreshPnl } from './pnlWorker.js';
import { renderPNL } from './renderers_pnl.js';

const bot = new Telegraf(process.env.BOT_TOKEN);

/* ====== Small helper: safe, immediate ack for callback queries ====== */
async function ack(ctx, text = '') {
  try { await ctx.answerCbQuery(text); } catch {} // ignore "query is too old" etc.
}

/* ====== PNL command ====== */
bot.command('pnl', async (ctx) => {
  try {
    const parts = (ctx.message?.text || '').trim().split(/\s+/);
    const wallet = (parts[1] || '').toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
      return ctx.reply('Usage: /pnl <walletAddress>');
    }
    await pnlQueue.add('pnl', { wallet, window: '30d' }, { removeOnComplete: true, removeOnFail: true });
    const data = await refreshPnl(wallet, '30d');
    const { text, extra } = renderPNL(data, '30d', 'overview');
    return ctx.replyWithHTML(text, extra);
  } catch (e) {
    console.error(e);
    return ctx.reply('PNL: something went wrong.');
  }
});

/* ====== HTML helpers (ensure consistent parse_mode) ====== */
const sendHTML = (ctx, text, extra = {}) =>
  ctx.replyWithHTML(text, { disable_web_page_preview: true, ...extra });

// Safe edit: swallow “message is not modified”
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
      return; // don’t re-ack here; query might be expired
    }
    throw err;
  }
};

/* ====== Data helpers ====== */
async function ensureData(ca) {
  try {
    const key = `token:${ca}:summary`;
    const cache = await getJSON(key);
    if (cache) return cache;

    const fresh = await refreshToken(ca);
    return fresh || null;
  } catch (e) {
    try {
      await queue.add('refresh', { tokenAddress: ca }, { removeOnComplete: true, removeOnFail: true });
    } catch (_) {}
    return null;
  }
}

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

/* ====== Commands ====== */
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

/* ====== Callback handlers ====== */

// noop buttons: just close the spinner (ack immediately)
bot.action('noop', async (ctx) => { await ack(ctx); });

// Main action router for stats/buyers/holders/refresh
bot.action(/^(stats|buyers|holders|refresh):/, async (ctx) => {
  await ack(ctx); // ack right away
  try {
    const [kind, ca, maybePage] = ctx.callbackQuery.data.split(':');

    if (kind === 'refresh') {
      const res = await requestRefresh(ca);
      // We already acked; optionally edit message or not—keep as is and show toast was handled
      return; // nothing else to do
    }

    const data = await ensureData(ca);
    if (!data) return; // already acked

    if (kind === 'stats') {
      const { text, extra } = renderOverview(data);
      return editHTML(ctx, text, extra);
    }

    if (kind === 'buyers') {
      const page = Number(maybePage || 1);
      const { text, extra } = renderBuyers(data, page);
      return editHTML(ctx, text, extra);
    }

    if (kind === 'holders') {
      const page = Number(maybePage || 1);
      const { text, extra } = renderHolders(data, page);
      return editHTML(ctx, text, extra);
    }
  } catch (e) {
    console.error(e);
    // ack already sent
  }
});

// ----- PNL view/window router: pnlview:<wallet>:<window>:<view>
bot.action(/^pnlview:0x[a-f0-9]{40}:(24h|7d|30d|90d|all):(overview|profits|losses|open|airdrops)$/i, async (ctx) => {
  await ack(ctx, 'Loading…'); // ack first
  try {
    const [, wallet, window, view] = ctx.callbackQuery.data.split(':');
    const data = await refreshPnl(wallet, window);
    const { text, extra } = renderPNL(data, window, view);
    await ctx.editMessageText(text, { ...extra, parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (e) {
    console.error(e);
  }
});

// ----- PNL legacy window switcher: pnl:<wallet>:<window>
bot.action(/^pnl:0x[a-f0-9]{40}:(24h|7d|30d|90d|all)$/i, async (ctx) => {
  await ack(ctx, 'Loading…');
  try {
    const [, wallet, window] = ctx.callbackQuery.data.split(':');
    const data = await refreshPnl(wallet, window);
    const { text, extra } = renderPNL(data, window, 'overview');
    await ctx.editMessageText(text, { ...extra, parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (e) {
    console.error(e);
  }
});

// ----- PNL refresh: pnl_refresh:<wallet>:<window>
bot.action(/^pnl_refresh:0x[a-f0-9]{40}:(24h|7d|30d|90d|all)$/i, async (ctx) => {
  await ack(ctx, 'Refreshing…');
  try {
    const [, wallet, window] = ctx.callbackQuery.data.split(':');
    await pnlQueue.add('pnl', { wallet, window }, { removeOnComplete: true, removeOnFail: true });
    const data = await refreshPnl(wallet, window);
    const { text, extra } = renderPNL(data, window, 'overview');
    await ctx.editMessageText(text, { ...extra, parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (e) {
    console.error(e);
  }
});

// About modal
bot.action('about', async (ctx) => {
  await ack(ctx);
  const { text, extra } = renderAbout();
  return editHTML(ctx, text, extra);
});

// ----- Boot -----
bot.launch().then(() => console.log('tABS Tools bot up.'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
