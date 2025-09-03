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

/* =================== Small helpers =================== */

const sendHTML = (ctx, text, extra = {}) =>
  ctx.replyWithHTML(text, { disable_web_page_preview: true, ...extra });

const editHTML = async (ctx, text, extra = {}) => {
  try {
    return await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  } catch (err) {
    // Silently ignore “message is not modified” and “query is too old”
    const d = err?.response?.description || '';
    if (d.includes('message is not modified') || d.includes('query is too old')) {
      try { await ctx.answerCbQuery(); } catch {}
      return;
    }
    throw err;
  }
};

/* =================== Data helpers =================== */

async function ensureData(ca) {
  try {
    const key = `token:${ca}:summary`;
    const cache = await getJSON(key);
    if (cache) return cache;

    // cold start: try a synchronous refresh once
    const fresh = await refreshToken(ca);
    return fresh || null;
  } catch {
    // enqueue and ask user to retry
    try {
      await queue.add('refresh', { tokenAddress: ca }, { removeOnComplete: true, removeOnFail: true });
    } catch (_) {}
    return null;
  }
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

/* =================== Commands =================== */

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

/* =================== PNL command =================== */
// Default view is "overview", default window is "30d"
bot.command('pnl', async (ctx) => {
  try {
    const parts = (ctx.message?.text || '').trim().split(/\s+/);
    const wallet = (parts[1] || '').toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
      return ctx.reply('Usage: /pnl <walletAddress>');
    }
    const window = '30d';
    const view = 'overview';

    // (Optional) warm queue
    await pnlQueue.add('pnl', { wallet, window }, { removeOnComplete: true, removeOnFail: true });

    const data = await refreshPnl(wallet, window);
    const { text, extra } = renderPNL(data, window, view);
    return ctx.replyWithHTML(text, extra);
  } catch (e) {
    console.error(e);
    return ctx.reply('PNL: something went wrong.');
  }
});

/* =================== Callback handlers =================== */

// close spinner for pure no-op
bot.action('noop', (ctx) => ctx.answerCbQuery('').catch(()=>{}));

// Stats/buyers/holders/refresh
bot.action(/^(stats|buyers|holders|refresh):/, async (ctx) => {
  try {
    const [kind, ca, maybePage] = (ctx.callbackQuery?.data || '').split(':');

    if (kind === 'refresh') {
      const res = await requestRefresh(ca);
      const msg = res.ok
        ? 'Refreshing…'
        : (typeof res.age === 'number'
            ? `Recently refreshed (${res.age.toFixed(0)}s ago). Try again shortly.`
            : `Couldn't queue refresh${res.error ? `: ${res.error}` : ''}`);
      return ctx.answerCbQuery(msg, { show_alert: false });
    }

    const data = await ensureData(ca);
    if (!data) {
      return ctx.answerCbQuery('Initializing… try again shortly.', { show_alert: true });
    }

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
    try { await ctx.answerCbQuery('Error — try again', { show_alert: true }); } catch {}
  }
});

// About modal
bot.action('about', async (ctx) => {
  const { text, extra } = renderAbout();
  return editHTML(ctx, text, extra);
});

/* ----------------- PNL callbacks ----------------- */
/**
 * New unified callback format:
 *   pn lv:<wallet>:<window>:<view>
 *     window ∈ {24h,7d,30d,90d,all}
 *     view   ∈ {overview,profits,losses,open,airdrops}
 */
bot.action(/^pnlv:0x[a-f0-9]{40}:(24h|7d|30d|90d|all):(overview|profits|losses|open|airdrops)$/i, async (ctx) => {
  try {
    const [, wallet, window, view] = (ctx.callbackQuery?.data || '').split(':');
    const data = await refreshPnl(wallet, window);
    const { text, extra } = renderPNL(data, window, view);
    await editHTML(ctx, text, extra);
    try { await ctx.answerCbQuery(); } catch {}
  } catch (e) {
    console.error(e);
    try { await ctx.answerCbQuery('Error'); } catch {}
  }
});

// Back-compat: old window switcher "pnl:<wallet>:<window>" -> go to overview
bot.action(/^pnl:0x[a-f0-9]{40}:(24h|7d|30d|90d|all)$/i, async (ctx) => {
  try {
    const [, wallet, window] = (ctx.callbackQuery?.data || '').split(':');
    const data = await refreshPnl(wallet, window);
    const { text, extra } = renderPNL(data, window, 'overview');
    await editHTML(ctx, text, extra);
    try { await ctx.answerCbQuery(); } catch {}
  } catch (e) {
    console.error(e);
    try { await ctx.answerCbQuery('Error'); } catch {}
  }
});

// Refresh: keep same window, go back to overview (safe default)
bot.action(/^pnl_refresh:0x[a-f0-9]{40}:(24h|7d|30d|90d|all)$/i, async (ctx) => {
  try {
    const [, wallet, window] = (ctx.callbackQuery?.data || '').split(':');
    await pnlQueue.add('pnl', { wallet, window }, { removeOnComplete: true, removeOnFail: true });
    const data = await refreshPnl(wallet, window);
    const { text, extra } = renderPNL(data, window, 'overview');
    await editHTML(ctx, text, extra);
    try { await ctx.answerCbQuery('Refreshed'); } catch {}
  } catch (e) {
    console.error(e);
    try { await ctx.answerCbQuery('Error'); } catch {}
  }
});

/* =================== Boot =================== */
bot.launch().then(() => console.log('tABS Tools bot up.'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));