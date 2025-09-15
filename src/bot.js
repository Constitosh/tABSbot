import { Telegraf, Markup } from 'telegraf';
import * as cache from './cache.js';
import { refreshToken, queue } from './refreshWorker.js';
import { isAddress, shortAddr, num, escapeMarkdownV2 } from './util.js';
import chains from '../chains.js';
import { renderTop20Holders, renderFirst20Buyers } from './services/compute.js';

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) => ctx.reply('Hi! Use /stats <tokenAddress> [chain] for token stats. See /help.'));

bot.help((ctx) => {
  const chainList = Object.keys(chains).map(c => `${c} (${chains[c].name})`).join(', ');
  ctx.reply(`Available V2 chains: ${chainList}\n\n/stats <CA> [chain] - Get full stats\n/refresh <CA> [chain] - Force refresh (30s cooldown)\nExample: /stats 0x123 base\nDefault chain: ethereum`);
});

bot.command('stats', async (ctx) => {
  const args = ctx.message.text.split(/\s+/).slice(1);
  const tokenAddress = args[0]?.trim();
  const chain = args[1]?.trim() || 'ethereum';

  if (!tokenAddress || !isAddress(tokenAddress)) {
    return ctx.reply('Invalid token address. Usage: /stats <address> [chain]');
  }
  if (!chains[chain]) {
    return ctx.reply(`Unsupported chain "${chain}" for Etherscan V2. Available: ${Object.keys(chains).join(', ')}`);
  }

  const key = `token:${chain}:${tokenAddress}:summary`;
  let data = await cache.getJSON(key);

  if (!data) {
    ctx.reply('Cache miss. Initializing (first fetch may take ~10s)...');
    try {
      data = await refreshToken(tokenAddress, chain);
    } catch (err) {
      ctx.reply(`Fetch failed: ${err.message}. Queued async—try /stats again in 30s.`);
      queue.add('refresh', { tokenAddress, chain });
      return;
    }
  }

  const { market, top10CombinedPct, burnedPct, creator, first20Buyers, holdersTop20, updatedAt } = data;
  let text = `*${market.name || 'Unknown'} (${market.symbol || '?'})*\n`;
  text += `\`${tokenAddress}\`\n\n`;
  text += `💰 Price: \\$${market.priceUsd.toFixed(6)}\n`;
  text += `📊 24h Vol: \\$${num(market.volume24h)}\n`;
  text += `📈 1h: ${market.priceChange.h1.toFixed(2)}\\% | 6h: ${market.priceChange.h6.toFixed(2)}\\% | 24h: ${market.priceChange.h24.toFixed(2)}\\%\n`;
  text += `💎 FDV: \\$${num(market.marketCap)}\n\n`;
  text += `*Creator:* \`${shortAddr(creator.address)}\` (${creator.percent.toFixed(2)}\\%)\n`;
  text += `*Top 10:* ${top10CombinedPct.toFixed(2)}\\%\n`;
  text += `*Burned:* ${burnedPct.toFixed(2)}\\%\n\n`;
  text += `*First 20 Buyers:*\n${renderFirst20Buyers(first20Buyers || [])}\n\n`;
  text += `*Top 20 Holders:*\n${renderTop20Holders(holdersTop20 || [])}\n\n`;
  text += `🕐 Updated: ${new Date(updatedAt).toLocaleString()}`;

  text = escapeMarkdownV2(text);

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh', `refresh:${chain}:${tokenAddress}`)]
  ]);

  return ctx.replyWithMarkdown(text, keyboard);
});

bot.command('refresh', async (ctx) => {
  const args = ctx.message.text.split(/\s+/).slice(1);
  const tokenAddress = args[0]?.trim();
  const chain = args[1]?.trim() || 'ethereum';

  if (!tokenAddress || !isAddress(tokenAddress) || !chains[chain]) {
    return ctx.reply('Invalid args. Usage: /refresh <address> [chain]');
  }

  const key = `token:${chain}:${tokenAddress}:summary`;
  const lastRefreshKey = `${key}:last_refresh`;
  const lastRefresh = await cache.getJSON(lastRefreshKey) || 0;
  if (Date.now() - lastRefresh < 30000) {
    return ctx.reply('⏰ 30s cooldown active. Try again soon.');
  }

  await cache.setJSON(lastRefreshKey, Date.now());
  queue.add('refresh', { tokenAddress, chain });
  ctx.reply('🔄 Refresh queued! Data updates in ~10s. Use /stats to check.');
});

bot.on('callback_query', async (ctx) => {
  const [action, ch, tokenAddress] = ctx.callbackQuery.data.split(':');
  const chain = ch;
  if (action === 'refresh' && chains[chain]) {
    const key = `token:${chain}:${tokenAddress}:summary`;
    const lastRefreshKey = `${key}:last_refresh`;
    const lastRefresh = await cache.getJSON(lastRefreshKey) || 0;
    if (Date.now() - lastRefresh < 30000) {
      return ctx.answerCbQuery('⏰ Cooldown: wait 30s');
    }
    await cache.setJSON(lastRefreshKey, Date.now());
    queue.add('refresh', { tokenAddress, chain });
    ctx.answerCbQuery('🔄 Refreshing... Check /stats soon.');
  }
  ctx.answerCbQuery();
});

bot.launch();

console.log('Bot started');