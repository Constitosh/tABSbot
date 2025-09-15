import './configEnv.js';
import { Telegraf } from 'telegraf';
import { getJSON, setJSON } from './cache.js';
import { queue, refreshToken } from './refreshWorker.js';
import { isAddress } from './util.js';
import { renderTop20Holders, renderFirst20Buyers } from './services/compute.js';

// Stubbed renderers
const renderOverview = (data) => {
  const { market, top10CombinedPct, burnedPct, holdersCount, creator, first20Buyers, holdersTop20, updatedAt } = data;
  let text = `<b>${market?.name || 'Unknown'} (${market?.symbol || '?'})</b>\n`;
  text += `<code>${data.tokenAddress}</code>\n\n`;
  text += market ? `💰 Price: $${market.priceUsd.toFixed(6)}\n` : '💰 Price: N/A\n';
  text += market ? `📊 24h Vol: $${market.volume24h.toLocaleString()}\n` : '📊 24h Vol: N/A\n';
  text += market ? `📈 1h: ${market.priceChange.h1.toFixed(2)}% | 6h: ${market.priceChange.h6.toFixed(2)}% | 24h: ${market.priceChange.h24.toFixed(2)}%\n` : '📈 Price Change: N/A\n';
  text += market ? `💎 FDV: $${market.marketCap.toLocaleString()}\n\n` : '💎 FDV: N/A\n\n';
  text += `<b>Creator:</b> <code>${creator.address.slice(0, 6)}...${creator.address.slice(-4)}</code> (${creator.percent.toFixed(2)}%)\n`;
  text += `<b>Top 10:</b> ${top10CombinedPct.toFixed(2)}%\n`;
  text += `<b>Burned:</b> ${burnedPct.toFixed(2)}%\n`;
  text += `<b>Holders:</b> ${holdersCount || 'N/A'}\n\n`;
  text += `<b>First 20 Buyers:</b>\n${renderFirst20Buyers(first20Buyers || [])}\n\n`;
  text += `<b>Top 20 Holders:</b>\n${renderTop20Holders(holdersTop20 || [])}\n\n`;
  text += `🕐 Updated: ${new Date(updatedAt).toLocaleString()}`;
  return {
    text,
    extra: {
      reply_markup: {
        inline_keyboard: [[
          { text: '🏠 Overview', callback_data: `stats:${data.tokenAddress}` },
          { text: '🧑‍🤝‍🧑 Buyers', callback_data: `buyers:${data.tokenAddress}:1` },
          ...(holdersTop20.length ? [{ text: '📊 Holders', callback_data: `holders:${data.tokenAddress}:1` }] : []),
          { text: '🔄 Refresh', callback_data: `refresh:${data.chain}:${data.tokenAddress}` }
        ]]
      }
    }
  };
};

const renderBuyers = (data, page = 1) => {
  const text = `<b>First 20 Buyers (Page ${page})</b>\n${renderFirst20Buyers(data.first20Buyers || [])}`;
  return { text, extra: { reply_markup: { inline_keyboard: [[
    { text: '🏠 Overview', callback_data: `stats:${data.tokenAddress}` },
    { text: '🔄 Refresh', callback_data: `refresh:${data.chain}:${data.tokenAddress}` }
  ]] } } };
};

const renderHolders = (data, page = 1) => {
  const text = `<b>Top 20 Holders (Page ${page})</b>\n${renderTop20Holders(data.holdersTop20 || [])}`;
  return { text, extra: { reply_markup: { inline_keyboard: [[
    { text: '🏠 Overview', callback_data: `stats:${data.tokenAddress}` },
    { text: '🔄 Refresh', callback_data: `refresh:${data.chain}:${data.tokenAddress}` }
  ]] } } };
};

// Stubs for missing files
const renderPNL = () => ({ text: 'PNL not supported', extra: {} });
const renderIndexView = () => ({ text: 'Index not supported', extra: {} });
const getIndexSnapshot = async () => null;
const buildIndexSnapshot = async () => null;
const ensureIndexSnapshot = async () => ({ ready: false });
const refreshPnl = async () => ({});

if (!process.env.BOT_TOKEN) {
  console.error('Bot: Missing BOT_TOKEN in .env');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: 30_000 });

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

const sendHTML = (ctx, text, extra = {}) =>
  ctx.replyWithHTML(text, { disable_web_page_preview: true, ...extra });

const editHTML = async (ctx, text, extra = {}) => {
  try {
    return await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra
    });
  } catch (err) {
    if (err?.response?.description?.includes('message is not modified')) {
      try { await ctx.answerCbQuery('Already up to date'); } catch {}
      return;
    }
    throw err;
  }
};

async function ensureData(ca, chain = 'abstract') {
  try {
    const key = `token:${chain}:${ca}:summary`;
    const cache = await getJSON(key);
    if (cache) return cache;
    const fresh = await refreshToken(ca, chain);
    return fresh || null;
  } catch (e) {
    try {
      await queue.add('refresh', { tokenAddress: ca, chain }, { removeOnComplete: true, removeOnFail: true });
    } catch {}
    return null;
  }
}

async function requestRefresh(ca, chain = 'abstract') {
  try {
    const last = await getJSON(`token:${chain}:${ca}:last_refresh`);
    const age = last ? (Date.now() - last.ts) / 1000 : Infinity;
    if (Number.isFinite(age) && age < 30) {
      return { ok: false, age };
    }
    await setJSON(`token:${chain}:${ca}:last_refresh`, { ts: Date.now() }, 600);
    await queue.add('refresh', { tokenAddress: ca, chain }, { removeOnComplete: true, removeOnFail: true });
    return { ok: true, age: Number.isFinite(age) ? age : null };
  } catch (e) {
    return { ok: false, error: e?.message || 'enqueue failed' };
  }
}

bot.start((ctx) => {
  console.log('Received /start command from', ctx.from.id);
  ctx.reply([
    'tABS Tools ready.',
    'Use /stats <contract>  •  /refresh <contract>',
    'Example: /stats 0x1234567890abcdef1234567890abcdef12345678',
  ].join('\n'));
});

bot.command('stats', async (ctx) => {
  console.log('Received /stats command:', ctx.message.text, 'from', ctx.from.id);
  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const caRaw = parts[1];
  const chain = parts[2] || 'abstract';
  if (!isAddress(caRaw)) return ctx.reply('Send: /stats <contractAddress> [chain]');

  const ca = caRaw.toLowerCase();
  const data = await ensureData(ca, chain);
  if (!data) return sendHTML(ctx, 'Initializing… try again in a few seconds.');

  const { text, extra } = renderOverview(data);
  return sendHTML(ctx, text, extra);
});

bot.command('refresh', async (ctx) => {
  console.log('Received /refresh command:', ctx.message.text, 'from', ctx.from.id);
  const parts = (ctx.message?.text || '').trim().split(/\s+/);
  const caRaw = parts[1];
  const chain = parts[2] || 'abstract';
  if (!isAddress(caRaw)) return ctx.reply('Send: /refresh <contractAddress> [chain]');

  const ca = caRaw.toLowerCase();
  const res = await requestRefresh(ca, chain);
  if (!res.ok) {
    if (typeof res.age === 'number') {
      return ctx.reply(`Recently refreshed (${res.age.toFixed(0)}s ago). Try again shortly.`);
    }
    return ctx.reply(`Couldn't queue refresh. ${res.error ? 'Error: ' + res.error : ''}`);
  }
  return ctx.reply(`Refreshing ${ca}…`);
});

bot.action('noop', (ctx) => ctx.answerCbQuery(''));

bot.action(/^(stats|buyers|holders|refresh):/, async (ctx) => {
  const dataStr = ctx.callbackQuery?.data || '';
  try {
    try { await ctx.answerCbQuery('Working…'); } catch {}
    const [kind, chain, ca, maybePage] = dataStr.split(':');
    if (kind === 'refresh') {
      const res = await requestRefresh(ca, chain);
      const msg = res.ok
        ? 'Refreshing…'
        : (typeof res.age === 'number'
            ? `Recently refreshed (${res.age.toFixed(0)}s ago). Try again shortly.`
            : `Couldn't queue refresh${res.error ? `: ${res.error}` : ''}`);
      try { await ctx.answerCbQuery(msg, { show_alert: false }); } catch {}
      return;
    }
    const data = await ensureData(ca, chain);
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

bot.launch().then(() => console.log('tABS Tools bot up.'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));