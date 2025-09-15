import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import * as cache from './cache.js';
import { refreshToken, queue } from './refreshWorker.js';
import { isAddress, shortAddr, num, escapeMarkdownV2 } from './util.js';
import chains from '../chains.js';
import { renderTop20Holders, renderFirst20Buyers } from './services/compute.js';

if (!process.env.BOT_TOKEN) {
  console.error('Bot: Missing BOT_TOKEN in .env');
  process.exit(1);
}
if (!process.env.ETHERSCAN_API_KEY) {
  console.error('Bot: Missing ETHERSCAN_API_KEY in .env');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
console.log('Bot initialized with token');

bot.start((ctx) => {
  console.log('Received /start command from', ctx.from.id);
  ctx.reply('Hi! Use /stats <tokenAddress> [chain] for token stats. See /help.');
});

bot.help((ctx) => {
  console.log('Received /help command from', ctx.from.id);
  const chainList = Object.keys(chains).map(c => `${c} (${chains[c].name})`).join(', ');
  ctx.reply(`Available chains: ${chainList}\n\n/stats <CA> [chain] - Get full stats\n/refresh <CA> [chain] - Force refresh (30s cooldown)\nExample: /stats 0x123 abstract\nDefault chain: abstract`);
});

bot.command('stats', async (ctx) => {
  console.log('Received /stats command:', ctx.message.text, 'from', ctx.from.id);
  const args = ctx.message.text.split(/\s+/).slice(1);
  const tokenAddress = args[0]?.trim();
  const chain = args[1]?.trim() || 'abstract';

  if (!tokenAddress || !isAddress(tokenAddress)) {
    return ctx.reply('Invalid token address. Usage: /stats <address> [chain]');
  }
  if (!chains[chain]) {
    return ctx.reply(`Unsupported chain "${chain}". Available: ${Object.keys(chains).join(', ')}`);
  }

  const key = `token:${chain}:${tokenAddress}:summary`;
  let data;
  try {
    data = await cache.getJSON(key);
  } catch (err) {
    console.error('Cache get error:', err.message);
    data = null;
  }

  if (!data) {
    ctx.reply('Cache miss. Initializing (first fetch may take ~10s)...');
    try {
      data = await refreshToken(tokenAddress, chain);
    } catch (err) {
      console.error('Refresh error:', err.message);
      ctx.reply(`Fetch failed: ${err.message}. Queued async—try /stats again in 30s.`);
      try {
        await queue.add('refresh', { tokenAddress, chain });
      } catch (queueErr) {
        console.error('Queue add error:', queueErr.message);
      }
      return;
    }
  }

  const { market, top10CombinedPct, burnedPct, holdersCount, creator, first20Buyers, holdersTop20, updatedAt } = data;
  let text = `*${market?.name || 'Unknown'} (${market?.symbol || '?'})*\n`;
  text += `\`${tokenAddress}\`\n\n`;
  text += market ? `💰 Price: \\$${market.priceUsd.toFixed(6)}\n` : '💰 Price: N/A\n';
  text += market ? `📊 24h Vol: \\$${num(market.volume24h)}\n` : '📊 24h Vol: N/A\n';
  text += market ? `📈 1h: ${market.priceChange.h1.toFixed(2)}\\% | 6h: ${market.priceChange.h6.toFixed(2)}\\% | 24h: ${market.priceChange.h24.toFixed(2)}\\%\n` : '📈 Price Change: N/A\n';
  text += market ? `💎 FDV: \\$${num(market.marketCap)}\n\n` : '💎 FDV: N/A\n\n';
  text += `*Creator:* \`${shortAddr(creator.address)}\` (${creator.percent.toFixed(2)}%)\n`;
  text += `*Top 10:* ${top10CombinedPct.toFixed(2)}%\n`;
  text += `*Burned:* ${burnedPct.toFixed(2)}%\n`;
  text += `*Holders:* ${holdersCount || 'N/A'}\n\n`;
  text += `*First 20 Buyers:*\n${renderFirst20Buyers(first20Buyers || [])}\n\n`;
  text += `*Top 20 Holders:*\n${renderTop20Holders(holdersTop20 || [])}\n\n`;
  text += `🕐 Updated: ${new Date(updatedAt).toLocaleString()}`;

  text = escapeMarkdownV2(text);

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh', `refresh:${chain}:${tokenAddress}`)]
  ]);

  try {
    return await ctx.replyWithMarkdown(text, keyboard);
  } catch (err) {
    console.error('Reply error:', err.message);
    return ctx.reply('Error sending response. Please try again.');
  }
});

bot.command('refresh', async (ctx) => {
  console.log('Received /refresh command:', ctx.message.text, 'from', ctx.from.id);
  const args = ctx.message.text.split(/\s+/).slice(1);
  const tokenAddress = args[0]?.trim();
  const chain = args[1]?.trim() || 'abstract';

  if (!tokenAddress || !isAddress(tokenAddress) || !chains[chain]) {
    return ctx.reply('Invalid args. Usage: /refresh <address> [chain]');
  }

  const key = `token:${chain}:${tokenAddress}:summary`;
  const lastRefreshKey = `token:${chain}:${tokenAddress}:last_refresh`;
  let lastRefresh;
  try {
    lastRefresh = await cache.getJSON(lastRefreshKey) || 0;
  } catch (err) {
    console.error('Cache get error for cooldown:', err.message);
    lastRefresh = 0;
  }
  if (Date.now() - lastRefresh < 30000) {
    return ctx.reply('⏰ 30s cooldown active. Try again soon.');
  }

  try {
    await cache.setJSON(lastRefreshKey, Date.now());
  } catch (err) {
    console.error('Cache set error for cooldown:', err.message);
  }
  try {
    await queue.add('refresh', { tokenAddress, chain });
    ctx.reply('🔄 Refresh queued! Data updates in ~10s. Use /stats to check.');
  } catch (err) {
    console.error('Queue add error:', err.message);
    ctx.reply('Failed to queue refresh due to cache issue. Try again later.');
  }
});

bot.on('callback_query', async (ctx) => {
  console.log('Received callback_query:', ctx.callbackQuery.data, 'from', ctx.from.id);
  const [action, ch, tokenAddress] = ctx.callbackQuery.data.split(':');
  const chain = ch;
  if (action === 'refresh' && chains[chain]) {
    const key = `token:${chain}:${tokenAddress}:summary`;
    const lastRefreshKey = `token:${chain}:${tokenAddress}:last_refresh`;
    let lastRefresh;
    try {
      lastRefresh = await cache.getJSON(lastRefreshKey) || 0;
    } catch (err) {
      console.error('Cache get error for callback:', err.message);
      lastRefresh = 0;
    }
    if (Date.now() - lastRefresh < 30000) {
      return ctx.answerCbQuery('⏰ Cooldown: wait 30s');
    }
    try {
      await cache.setJSON(lastRefreshKey, Date.now());
    } catch (err) {
      console.error('Cache set error for callback:', err.message);
    }
    try {
      await queue.add('refresh', { tokenAddress, chain });
      ctx.answerCbQuery('🔄 Refreshing... Check /stats soon.');
    } catch (err) {
      console.error('Queue add error for callback:', err.message);
      ctx.answerCbQuery('Failed to queue refresh due to cache issue.');
    }
  } else {
    ctx.answerCbQuery();
  }
});

bot.launch().then(() => {
  console.log('Bot polling started');
}).catch((err) => {
  console.error('Bot launch error:', err.message);
  process.exit(1);
});

console.log('Bot startup complete');