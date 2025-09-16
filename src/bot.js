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

// Load summary if cached; otherwise do a one-shot refresh (on preferred chain) or enqueue.
async function ensureData(ca, preferredChainKey = 'tabs') {
  try {
    // 1) If already cached on any chain, return it.
    const hit = await findSummaryAnyChain(ca);
    if (hit?.data) return hit.data;

    // 2) Cold start: try synchronous refresh once on preferred chain
    const fresh = await refreshToken(ca, preferredChainKey);
    if (fresh) return fresh;

    // 3) Enqueue and let user retry
    try {
      await queue.add('refresh', { tokenAddress: ca, chain: preferredChainKey }, { removeOnComplete: true, removeOnFail: true });
    } catch (_) {}
    return null;
  } catch (e) {
    try {
      await queue.add('refresh', { tokenAddress: ca, chain: preferredChainKey }, { removeOnComplete: true, removeOnFail: true });
    } catch (_) {}
    return null;
  }
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
      'tABS Tools ready.',
      'Use /stats <contract>  •  /refresh <contract>  •  /pnl <wallet>',
      'Or use chain-specific commands like /tabs <contract> or /base <contract>',
      'Example: /stats 0x1234567890abcdef1234567890abcdef12345678',
      'Example: /pnl   0x1234567890abcdef1234567890abcdef12345678',
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

  const { text, extra } = renderOverview(data);
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

    // Try to serve from cache first; if empty, do a one-shot refresh on that chain
    const hit = await findSummaryAnyChain(ca);
    if (!hit?.data) {
      try {
        await refreshToken(ca, chain.key);
      } catch {
        try { await queue.add('refresh', { tokenAddress: ca, chain: chain.key }, { removeOnComplete: true, removeOnFail: true }); } catch {}
        return ctx.reply('Initializing… try again in a few seconds.');
      }
    }

    // Load again (will find the namespaced key for this chain)
    const finalHit = await findSummaryAnyChain(ca);
    const data = finalHit?.data;
    if (!data) return ctx.reply('Initializing… try again in a few seconds.');

    const { text, extra } = renderOverview(data);
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

/* ====== Callback handlers ====== */

// noop buttons: just close the spinner
bot.action('noop', (ctx) => ctx.answerCbQuery(''));

// Main action router for stats/buyers/holders/refresh/index
// NOTE: callbacks don't include chain, so we detect chain from cache when needed
bot.action(/^(stats|buyers|holders|refresh|index):/, async (ctx) => {
  const dataStr = ctx.callbackQuery?.data || '';
  try {
    // ACK asap so Telegram doesn't show "loading…" forever
    try { await ctx.answerCbQuery('Working…'); } catch {}

    const [kind, ca, maybePage] = dataStr.split(':');

    // ---------- Refresh ----------
    if (kind === 'refresh') {
      // detect cached chain
      const hit = await findSummaryAnyChain(ca);
      const hintChain = hit?.chainKey || 'tabs';
      const res = await requestRefresh(ca, hintChain);
      const msg = res.ok
        ? 'Refreshing…'
        : (typeof res.age === 'number'
            ? `Recently refreshed (${res.age.toFixed(0)}s ago). Try again shortly.`
            : `Couldn't queue refresh${res.error ? `: ${res.error}` : ''}`);
      try { await ctx.answerCbQuery(msg, { show_alert: false }); } catch {}
      return;
    }

    // We need summary data for all tabs (chain-agnostic fetch)
    const hit = await findSummaryAnyChain(ca);
    const data = hit?.data || null;
    if (!data) {
      try { await ctx.answerCbQuery('Initializing… try again shortly.', { show_alert: true }); } catch {}
      return;
    }

    // ---------- Overview ----------
    if (kind === 'stats') {
      const { text, extra } = renderOverview(data);
      await editHTML(ctx, text, extra);
      return;
    }

    // ---------- Buyers (paginated) ----------
    if (kind === 'buyers') {
      const page = Number(maybePage || 1);
      const { text, extra } = renderBuyers(data, page);
      await editHTML(ctx, text, extra);
      return;
    }

    // ---------- Holders (paginated) ----------
    if (kind === 'holders') {
      const page = Number(maybePage || 1);
      const { text, extra } = renderHolders(data, page);
      await editHTML(ctx, text, extra);
      return;
    }

    // ---------- Index (holder distribution snapshot) ----------
    if (kind === 'index') {
      // 1) Show a safe “working” view immediately (no raw `$` or unclosed tags).
      await editHTML(
        ctx,
        '📈 <b>Index</b>\n\n<i>Crunching holder distribution…</i>\n\nThis runs once and is cached for 6 hours.',
        {
          reply_markup: {
            inline_keyboard: [[
              { text:'🏠 Overview',        callback_data:`stats:${ca}` },
              { text:'🧑‍🤝‍🧑 Buyers',     callback_data:`buyers:${ca}:1` },
              ...(Array.isArray(data?.holdersTop20) && data.holdersTop20.length
                ? [{ text:'📊 Holders',    callback_data:`holders:${ca}:1` }]
                : [])
            ]]
          }
        }
      );

      // 2) Kick off (or retrieve) the snapshot without blocking the UI.
      const chainKey = hit?.chainKey || 'tabs';
      const first = await ensureIndexSnapshot(ca, chainKey);   // { ready: boolean, data?: snapshot }

      // 3) Render either the “preparing…” placeholder or the finished snapshot.
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
bot.on('callback_query', async (ctx) => {
  const d = ctx.callbackQuery?.data || '';
  try {
    // ACK immediately so Telegram doesn't expire the callback
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

    // ignore other callback routes here (handled above)
  } catch (e) {
    console.error('[PNL cb] error:', e?.response?.description || e);
    try { await ctx.answerCbQuery('Error'); } catch {}
  }
});

bot.action(/^index_refresh:/, async (ctx) => {
  try {
    const ca = ctx.callbackQuery?.data?.split(':')[1];
    if (!/^0x[a-f0-9]{40}$/.test(ca)) return ctx.answerCbQuery('Bad address');

    // detect chain for snapshot build
    const hit = await findSummaryAnyChain(ca);
    const chainKey = hit?.chainKey || 'tabs';

    await ctx.answerCbQuery('Refreshing…');
    const snap = await buildIndexSnapshot(ca, chainKey); // force rebuild + cache
    const { text, extra } = renderIndexView(hit?.data || null, { ready: true, data: snap });
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
