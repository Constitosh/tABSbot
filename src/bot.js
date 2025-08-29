import { Telegraf } from 'telegraf';
import { getJSON, setJSON } from './cache.js';
import { queue, refreshToken } from './refreshWorker.js';
import { renderTop20Holders, renderFirst20Buyers } from './services/compute.js';
import { isAddress, num, pct } from './util.js';
import 'dotenv/config';

const bot = new Telegraf(process.env.BOT_TOKEN);

// Helper to fetch or init
async function ensureData(ca) {
  const cache = await getJSON(`token:${ca}:summary`);
  if (cache) return cache;
  // cold start: do a synchronous refresh (first time) to reduce the "try later" effect
  try { return await refreshToken(ca); }
  catch {
    // fallback: enqueue
    await queue.add('refresh', { tokenAddress: ca }, { removeOnComplete: true, removeOnFail: true });
    return null;
  }
}

// /start
bot.start(ctx => ctx.reply(
  `tABS Tools ready.\n` +
  `Use /stats <contract>  •  /refresh <contract>\n` +
  `Example: /stats 0x1234...`
));

// /stats <ca>
bot.command('stats', async (ctx) => {
  const [, ca] = ctx.message.text.trim().split(/\s+/);
  if (!isAddress(ca)) return ctx.reply('Send: /stats <contractAddress>');

  const data = await ensureData(ca);
  if (!data) return ctx.reply('Initializing… try again in a few seconds.');

  const m = data.market || {};
  const t1 = [
    `*${m.name || 'Token'}* (${m.symbol || ''})`,
    `CA: \`${ca}\``,
    ``,
    `Price: *$${num(m.priceUsd, 8)}*`,
    `24h Vol: *$${num(m.volume24h)}*`,
    `Change: 1h *${pct(m.priceChange?.h1)}*  •  6h *${pct(m.priceChange?.h6)}*  •  24h *${pct(m.priceChange?.h24)}*`,
    `Market Cap (FDV): *$${num(m.marketCap)}*`,
    ``,
    `Creator: \`${data.creator.address || 'unknown'}\`  —  *${pct(data.creator.percent)}*`,
    `Top 10 combined: *${pct(data.top10CombinedPct)}*`,
    `Burned: *${pct(data.burnedPct)}*`,
    ``,
    `*First 20 buyers (status)*`,
    renderFirst20Buyers(data.first20Buyers),
    ``,
    `*Top 20 holders (%)*`,
    renderTop20Holders(data.holdersTop20),
    ``,
    `_Updated: ${new Date(data.updatedAt).toLocaleString()}_`
  ].join('\n');

  await ctx.replyWithMarkdownV2(t1.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1'), { disable_web_page_preview: true });
});

// /refresh <ca>
bot.command('refresh', async (ctx) => {
  const [, ca] = ctx.message.text.trim().split(/\s+/);
  if (!isAddress(ca)) return ctx.reply('Send: /refresh <contractAddress>');

  const last = await getJSON(`token:${ca}:last_refresh`);
  const age = last ? (Date.now() - last.ts)/1000 : 9999;
  if (age < 30) return ctx.reply(`Recently refreshed (${age.toFixed(0)}s ago). Try again shortly.`);

  await setJSON(`token:${ca}:last_refresh`, { ts: Date.now() }, 600);
  await queue.add('refresh', { tokenAddress: ca }, { removeOnComplete: true, removeOnFail: true });
  return ctx.reply(`Refreshing ${ca}…`);
});

bot.launch().then(() => console.log('tABS Tools bot up.'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
