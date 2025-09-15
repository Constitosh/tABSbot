// src/bot.js
import './configEnv.js';
import { Telegraf } from 'telegraf';
import { getJSON, setJSON } from './cache.js';
import { queue } from './queueCore.js';               // keep your queueCore wiring
import { renderOverview, renderBuyers, renderHolders, renderAbout } from './renderers.js';
import { isAddress } from './util.js';

import { refreshPnl } from './pnlWorker.js';
import { renderPNL } from './renderers_pnl.js';

import { getIndexSnapshot, buildIndexSnapshot } from './indexer.js';
import { ensureIndexSnapshot } from './indexWorker.js';
import { renderIndexView } from './renderers_index.js';

import { getChainByCmd, chainKey } from './chains.js';

// --- Bot with longer handler timeout + global error catcher ---
const bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: 30_000 });

bot.use(async (ctx, next) => {
  try { await next(); } catch (err) {
    console.error('[TG] middleware error:', err?.response?.description || err);
  }
});
bot.catch((err, ctx) => {
  console.error('[TG] Global bot.catch error on update', ctx.updateType, err?.response?.description || err);
});

// ----- HTML helpers -----
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
    const desc = err?.response?.description || '';
    if (desc.includes('message is not modified')) {
      try { await ctx.answerCbQuery('Already up to date'); } catch {}
      return;
    }
    throw err;
  }
};

// ----- Data helpers (multi-chain) -----
async function ensureDataChain(ca, dsChain, esChain) {
  const ck = chainKey(dsChain);
  const key = `token:${ck}:${ca}:summary`;
  const cache = await getJSON(key);
  if (cache) return cache;

  // cold start: ENQUEUE only (so we keep chain separation)
  try {
    await setJSON(`token:${ck}:${ca}:last_refresh`, { ts: Date.now() }, 600);
    await queue.add('refresh',
      { tokenAddress: ca, dsChain, esChain },
      { removeOnComplete: true, removeOnFail: true }
    );
  } catch (_) {}
  return null;
}

// Backward-compat for /stats (Abstract default)
async function ensureDataAbstract(ca) {
  const key = `token:abstract:${ca}:summary`;
  const cache = await getJSON(key);
  if (cache) return cache;
  try {
    await setJSON(`token:abstract:${ca}:last_refresh`, { ts: Date.now() }, 600);
    await queue.add('refresh',
      { tokenAddress: ca, dsChain: 'abstract', esChain: '2741' },
      { removeOnComplete: true, removeOnFail: true }
    );
  } catch (_) {}
  return null;
}

// Always return { ok:boolean, age?:number, error?:string } (multi-chain)
async function requestRefreshChain(ca, dsChain, esChain) {
  const ck = chainKey(dsChain);
  try {
    const last = await getJSON(`token:${ck}:${ca}:last_refresh`);
    const age = last ? (Date.now() - last.ts) / 1000 : Infinity;

    if (Number.isFinite(age) && age < 30) {
      return { ok: false, age };
    }

    await setJSON(`token:${ck}:${ca}:last_refresh`, { ts: Date.now() }, 600);
    await queue.add('refresh',
      { tokenAddress: ca, dsChain, esChain },
      { removeOnComplete: true, removeOnFail: true }
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ----- Commands -----
bot.start((ctx) =>
  ctx.reply(
    [
      'tABS Tools ready.',
      'Use /tabs <contract> (Abstract)  •  /tbase <contract> (Base)  •  /thyper <contract> (HyperEVM)',
      'Also: /pnl <wallet>',
      'Example: /tabs  0x1234...abcd',
    ].join('\n')
  )
);

// (legacy) /stats <ca> — stays Abstract
bot.command('stats', async (ctx) => {
  const [, caRaw] = (ctx.message?.text || '').trim().split(/\s+/);
  if (!isAddress(caRaw)) return ctx.reply('Send: /stats <contractAddress>');
  const ca = caRaw.toLowerCase();

  const data = await ensureDataAbstract(ca);
  if (!data) return ctx.reply('Initializing… try again in a few seconds.');

  const { text, extra } = renderOverview(data);
  return sendHTML(ctx, text, extra);
});

// /tabs <ca> (Abstract)
bot.command('tabs', async (ctx) => {
  const [, caRaw] = (ctx.message?.text || '').trim().split(/\s+/);
  if (!isAddress(caRaw)) return ctx.reply('Send: /tabs <contractAddress>');
  const ca = caRaw.toLowerCase();
  const chain = getChainByCmd('tabs');

  const data = await ensureDataChain(ca, chain.ds, chain.es);
  if (!data) return ctx.reply('Initializing… try again in a few seconds.');

  const { text, extra } = renderOverview(data);
  return sendHTML(ctx, text, extra);
});

// /tbase <ca>
bot.command('tbase', async (ctx) => {
  const [, caRaw] = (ctx.message?.text || '').trim().split(/\s+/);
  if (!isAddress(caRaw)) return ctx.reply('Send: /tbase <contractAddress>');
  const ca = caRaw.toLowerCase();
  const chain = getChainByCmd('tbase');

  const data = await ensureDataChain(ca, chain.ds, chain.es);
  if (!data) return ctx.reply('Initializing… try again in a few seconds.');

  const { text, extra } = renderOverview(data);
  return sendHTML(ctx, text, extra);
});

// /thyper <ca>
bot.command('thyper', async (ctx) => {
  const [, caRaw] = (ctx.message?.text || '').trim().split(/\s+/);
  if (!isAddress(caRaw)) return ctx.reply('Send: /thyper <contractAddress>');
  const ca = caRaw.toLowerCase();
  const chain = getChainByCmd('thyper');

  const data = await ensureDataChain(ca, chain.ds, chain.es);
  if (!data) return ctx.reply('Initializing… try again in a few seconds.');

  const { text, extra } = renderOverview(data);
  return sendHTML(ctx, text, extra);
});

// /refresh <ca> — legacy abstract
bot.command('refresh', async (ctx) => {
  const [, caRaw] = (ctx.message?.text || '').trim().split(/\s+/);
  if (!isAddress(caRaw)) return ctx.reply('Send: /refresh <contractAddress>');
  const ca = caRaw.toLowerCase();
  const res = await requestRefreshChain(ca, 'abstract', '2741');
  if (!res.ok) {
    if (typeof res.age === 'number') {
      return ctx.reply(`Recently refreshed (${res.age.toFixed(0)}s ago). Try again shortly.`);
    }
    return ctx.reply(`Couldn't queue refresh. ${res.error ? 'Error: ' + res.error : ''}`);
  }
  return ctx.reply(`Refreshing ${ca}…`);
});

// PNL (unchanged)
bot.command('pnl', async (ctx) => {
  try {
    const parts = (ctx.message?.text || '').trim().split(/\s+/);
    const wallet = (parts[1] || '').toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(wallet)) {
      return ctx.reply('Usage: /pnl <walletAddress>');
    }
    const data = await refreshPnl(wallet, '30d');
    const { text, extra } = renderPNL(data, '30d', 'overview');
    return ctx.replyWithHTML(text, extra);
  } catch (e) {
    console.error('[PNL /pnl] error:', e?.message || e);
    return ctx.reply('PNL: something went wrong.');
  }
});

/* ====== Callback handlers ====== */

// noop
bot.action('noop', (ctx) => ctx.answerCbQuery(''));

// Existing “stats/buyers/holders/refresh/index” callbacks still work (Abstract).
// If you want chain-specific callbacks later, include ds/es in callback_data and thread them through.

bot.launch().then(() => console.log('tABS Tools bot up.'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));