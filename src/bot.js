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

// INDEX — multichain-aware wrappers
import { ensureIndexSnapshot, buildIndexSnapshot } from './indexWorker.js';
import { renderIndexView } from './renderers_index.js';

// MULTICHAIN
import { CHAINS } from './chains.js';

// --- Bot with longer handler timeout + global error catcher ---
const bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: 60_000 });

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

// ===== Multichain-aware helpers =====

// Try all chains for a given token cache key and return {chainKey, data} or null
async function findSummaryAnyChain(ca) {
  for (const c of Object.values(CHAINS)) {
    const key = `token:${c.key}:${ca}:summary`;
    const data = await getJSON(key);
    if (data) return { chainKey: c.key, data };
  }
  // Legacy (pre-multichain) fallback:
  const legacy = await getJSON(`token:${ca}:summary`);
  if (legacy) return { chainKey: 'tabs', data: legacy };
  return null;
}

// Load summary on a specific chain; if not in cache, do a one-shot refresh on that chain (or enqueue).
async function ensureData(ca, chainKey = 'tabs') {
  const key = `token:${chainKey}:${ca}:summary`;
  const cache = await getJSON(key);
  if (cache) return cache;

  // cold start: try a synchronous refresh once on the selected chain
  try {
    const fresh = await refreshToken(ca, chainKey);
    if (fresh) return fresh;
  } catch (_) {}

  // enqueue and ask user to retry
  try {
    await queue.add('refresh', { tokenAddress: ca, chain: chainKey }, { removeOnComplete: true, removeOnFail: true });
  } catch (_) {}
  return null;
}

// Always return { ok:boolean, age?:number, error?:string }
async function requestRefresh(ca, hintChainKey = null) {
  try {
    // detect chain of cached summary first
    let chainKey = hintChainKey;
    if (!chainKey) {
      const hit = await findSummaryAnyChain(ca);
      if (hit?.chainKey) chainKey = hit.chainKey;
    }
    if (!chainKey) chainKey = 'tabs'; // default

    const last = await getJSON(`token:${chainKey}:${ca}:last_refresh`);
    const age = last ? (Date.now() - last.ts) / 1000 : Infinity;

    if (Number.isFinite(age) && age < 30) {
      return { ok: false, age };
    }

    await setJSON(`token:${chainKey}:${ca}:last_refresh`, { ts: Date.now() }, 600);
    await queue.add('refresh', { tokenAddress: ca, chain: chainKey }, { removeOnComplete: true, removeOnFail: true });

    return { ok: true, age: Number.isFinite(age) ? age : null };
  } catch (e) {
    return { ok: false, error: e?.message || 'enqueue failed' };
  }
}

// ----- Commands -----
bot.start((ctx) =>
  ctx.reply(
    [
      'the tABS Laboratory on Telegram is ready. If you see this message the bot is live!',
      'Use /tabs <contract>  •  /pnl <wallet>',
    ].join('\n')
  )
);

// ===== Default commands (backward compatible) — default to 'tabs' =====

// /stats <ca>
bot.command('stats', async (ctx) => {
  const [, caRaw] = (ctx.message?.text || '').trim().split(/\s+/);
  if (!isAddress(caRaw)) return ctx.reply('Send: /stats <contractAddress>');

  const ca = caRaw.toLowerCase();
  const data = await ensureData(ca, 'tabs');
  if (!data) return ctx.reply('Initializing… try again in a few seconds.');

  const { text, extra } = renderOverview(data, 'tabs'); // pass chain for chain-aware buttons
  return sendHTML(ctx, text, extra);
});

// /refresh <ca>
bot.command('refresh', async (ctx) => {
  const [, caRaw] = (ctx.message?.text || '').trim().split(/\s+/);
  if (!isAddress(caRaw)) return ctx.reply('Send: /refresh <contractAddress>');

  const ca = caRaw.toLowerCase();
  // Try to infer chain first; fallback to tabs
  const inferred = await findSummaryAnyChain(ca);
  const hintChainKey = inferred?.chainKey || 'tabs';

  const res = await requestRefresh(ca, hintChainKey);

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
    // default to tabs
    const data = await refreshPnl(wallet, '30d', 'tabs'); // window: 24h|7d|30d|90d|all
    const { text, extra } = renderPNL(data, '30d', 'overview');
    return ctx.replyWithHTML(text, extra);
  } catch (e) {
    console.error('[PNL /pnl] error:', e?.message || e);
    return ctx.reply('PNL: something went wrong.');
  }
});

// ===== AUTO-GENERATED CHAIN COMMANDS from chains.js =====
// Provides: /<chain> <ca> and /<chain>pnl <wallet>
for (const chain of Object.values(CHAINS)) {
  // /<chain> <ca>
  bot.command(chain.key, async (ctx) => {
    const [, caRaw] = (ctx.message?.text || '').trim().split(/\s+/);
    if (!isAddress(caRaw)) return ctx.reply(`Send: /${chain.key} <contractAddress>`);

    const ca = caRaw.toLowerCase();

    // Force this chain (no cross-chain fallback):
    const data = await ensureData(ca, chain.key);
    if (!data) return ctx.reply('Initializing… try again in a few seconds.');

    const { text, extra } = renderOverview(data, chain.key); // chain-aware buttons
    return sendHTML(ctx, text, extra);
  });

  // /<chain>pnl <wallet>
  bot.command(chain.key + 'pnl', async (ctx) => {
    const [, wallet] = (ctx.message?.text || '').trim().split(/\s+/);
    if (!wallet) return ctx.reply(`Send: /${chain.key}pnl <walletAddress>`);
    try {
      const data = await refreshPnl(String(wallet).toLowerCase(), '30d', chain.key);
      const { text, extra } = renderPNL(data, '30d', 'overview');
      return ctx.replyWithHTML(text, extra);
    } catch (e) {
      console.error('[PNL cmd] error:', e?.message || e);
      return ctx.reply('PNL error: ' + (e?.message || 'unknown'));
    }
  });
}

/* ====== Callback helpers ====== */

// parse cb payloads supporting both:
//   legacy: kind:<ca>[:page]
//   new:    kind:<chainKey>:<ca>[:page]
function parseChainCb(payload) {
  const [kind, rest] = payload.split(':', 2);
  const parts = payload.split(':'); // full
  // try new format
  if (parts.length >= 3 && CHAINS[parts[1]]) {
    const chainKey = parts[1];
    const ca = parts[2];
    const page = parts[3] ? Number(parts[3]) : undefined;
    return { kind, chainKey, ca, page };
  }
  // legacy
  const [, ca, pageMaybe] = parts;
  return { kind, chainKey: null, ca, page: pageMaybe ? Number(pageMaybe) : undefined };
}

/* ====== Callback handlers ====== */

// noop buttons: just close the spinner
bot.action('noop', (ctx) => ctx.answerCbQuery(''));

// Main action router for stats/buyers/holders/refresh/index
bot.action(/^(stats|buyers|holders|refresh|index):/, async (ctx) => {
  const payload = ctx.callbackQuery?.data || '';
  try {
    try { await ctx.answerCbQuery('Working…'); } catch {}

    const { kind, chainKey: cbChain, ca, page } = parseChainCb(payload);

    // Determine chain for this token
    let chainKey = cbChain;
    if (!chainKey) {
      const hit = await findSummaryAnyChain(ca);
      chainKey = hit?.chainKey || 'tabs';
    }

    // ---------- Refresh ----------
    if (kind === 'refresh') {
      const res = await requestRefresh(ca, chainKey);
      const msg = res.ok
        ? 'Refreshing…'
        : (typeof res.age === 'number'
            ? `Recently refreshed (${res.age.toFixed(0)}s ago). Try again shortly.`
            : `Couldn't queue refresh${res.error ? `: ${res.error}` : ''}`);
      try { await ctx.answerCbQuery(msg, { show_alert: false }); } catch {}
      return;
    }

    // Load chain-specific summary
    const data = await getJSON(`token:${chainKey}:${ca}:summary`)
      || (await findSummaryAnyChain(ca))?.data
      || null;

    if (!data) {
      try { await ctx.answerCbQuery('Initializing… try again shortly.', { show_alert: true }); } catch {}
      return;
    }

    // ---------- Overview ----------
    if (kind === 'stats') {
      const { text, extra } = renderOverview(data, chainKey);
      await editHTML(ctx, text, extra);
      return;
    }

    // ---------- Buyers ----------
    if (kind === 'buyers') {
      const p = Number(page || 1);
      const { text, extra } = renderBuyers(data, p, chainKey);
      await editHTML(ctx, text, extra);
      return;
    }

    // ---------- Holders ----------
    if (kind === 'holders') {
      const p = Number(page || 1);
      const { text, extra } = renderHolders(data, p, chainKey);
      await editHTML(ctx, text, extra);
      return;
    }

    // ---------- Index ----------
    if (kind === 'index') {
      await editHTML(
        ctx,
        '📈 <b>Index</b>\n\n<i>Crunching holder distribution…</i>\n\nThis runs once and is cached for 6 hours.',
        {
          reply_markup: {
            inline_keyboard: [[
              { text:'🏠 Overview',        callback_data:`stats:${chainKey}:${ca}` },
              { text:'🧑‍🤝‍🧑 Buyers',     callback_data:`buyers:${chainKey}:${ca}:1` },
              { text:'📊 Holders',         callback_data:`holders:${chainKey}:${ca}:1` },
            ]]
          }
        }
      );

      const first = await ensureIndexSnapshot(ca, chainKey); // { ready, data? }
      const { text, extra } = renderIndexView(data, first);
      await editHTML(ctx, text, extra);
      return;
    }

  } catch (e) {
    console.error('[stats/buyers/holders/index cb] error:', e?.response?.description || e);
    try { await ctx.answerCbQuery('Error — try again', { show_alert: true }); } catch {}
  }
});

// ----- PNL callbacks (windows / views / refresh) -----
// (still defaulting to tabs; extend if you later add chain-aware PNL callbacks)
bot.on('callback_query', async (ctx) => {
  const d = ctx.callbackQuery?.data || '';
  try {
    try { await ctx.answerCbQuery('Working…'); } catch {}

    if (d.startsWith('pnlv:')) {
      const [, wallet, window, view] = d.split(':');
      const data = await refreshPnl(wallet, window, 'tabs');
      const { text, extra } = renderPNL(data, window, view);
      await ctx.editMessageText(text, { ...extra, parse_mode: 'HTML', disable_web_page_preview: true });
      return;
    }

    if (d.startsWith('pnl:')) {
      const [, wallet, window] = d.split(':');
      const data = await refreshPnl(wallet, window, 'tabs');
      const { text, extra } = renderPNL(data, window, 'overview');
      await ctx.editMessageText(text, { ...extra, parse_mode: 'HTML', disable_web_page_preview: true });
      return;
    }

    if (d.startsWith('pnl_refresh:')) {
      const [, wallet, window] = d.split(':');
      const data = await refreshPnl(wallet, window, 'tabs');
      const { text, extra } = renderPNL(data, window, 'overview');
      await ctx.editMessageText(text, { ...extra, parse_mode: 'HTML', disable_web_page_preview: true });
      try { await ctx.answerCbQuery('Refreshed'); } catch {}
      return;
    }

  } catch (e) {
    console.error('[PNL cb] error:', e?.response?.description || e);
    try { await ctx.answerCbQuery('Error'); } catch {}
  }
});

// Support both: index_refresh:<chainKey>:<ca> and legacy index_refresh:<ca>
bot.action(/^index_refresh:/, async (ctx) => {
  try {
    const parts = (ctx.callbackQuery?.data || '').split(':'); // index_refresh:...
    let chainKey = 'tabs';
    let ca = '';

    if (parts.length >= 3 && CHAINS[parts[1]]) {
      chainKey = parts[1];
      ca = parts[2];
    } else {
      ca = parts[1];
      const hit = await findSummaryAnyChain(ca);
      if (hit?.chainKey) chainKey = hit.chainKey;
    }

    if (!/^0x[a-f0-9]{40}$/.test(ca)) return ctx.answerCbQuery('Bad address');

    await ctx.answerCbQuery('Refreshing…');
    const snap = await buildIndexSnapshot(ca, chainKey); // force rebuild + cache
    const baseSummary = await getJSON(`token:${chainKey}:${ca}:summary`);
    const { text, extra } = renderIndexView(baseSummary || { tokenAddress: ca }, { ready: true, data: snap });
    await editHTML(ctx, text, extra);
    try { await ctx.answerCbQuery('Refreshed'); } catch {}
  } catch (e) {
    console.error('[INDEX refresh] error:', e?.message || e);
    try { await ctx.answerCbQuery('Error'); } catch {}
  }
});

// ----- Boot -----
bot.launch().then(() => console.log('tABS Tools bot up.'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));