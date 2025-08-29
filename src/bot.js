// src/bot.js
import './configEnv.js';
import { Telegraf } from 'telegraf';
import { getJSON, setJSON } from './cache.js';
import { queue, refreshToken } from './queueCore.js';
import { renderOverview, renderBuyers, renderHolders } from './renderers.js';
import { isAddress } from './util.js';

const bot = new Telegraf(process.env.BOT_TOKEN);

// --- Helpers ---

// Fetch from cache or do a synchronous first refresh (cold start)
async function ensureData(ca) {
  const key = `token:${ca}:summary`;
  const cache = await getJSON(key);
  if (cache) return cache;

  try {
    // Try a synchronous refresh once on cold start
    return await refreshToken(ca);
  } catch (e) {
    // Fallback: enqueue an async refresh and tell caller to retry soon
    await queue.add('refresh', { tokenAddress: ca }, { removeOnComplete: true, removeOnFail: true });
    return null;
  }
}

// Cooldown + enqueue a refresh job
async function requestRefresh(ca) {
  const last = await getJSON(`token:${ca}:last_refresh`);
  const age = last ? (Date.now() - last.ts) / 1000 : Infinity;
  if (age < 30) {
    return { ok: false, age };
  }
  await setJSON(`token:${ca}:last_refresh`, { ts: Date.now() }, 600);
  await queue.add('refresh', { tokenAddress: ca }, { removeOnComplete: true, removeOnFail: true });
  return { ok: true, age };
}

// --- Commands ---

bot.start((ctx) =>
  ctx.reply(
    [
      'tABS Tools ready.',
      'Use /stats <contract>  •  /refresh <contract>',
      'Example: /stats 0x1234567890abcdef1234567890abcdef12345678'
    ].join('\n')
  )
);

// /stats <ca> — Overview screen
bot.command('stats', async (ctx) => {
  const [, caRaw] = ctx.message.text.trim().split(/\s+/);
  if (!isAddress(caRaw)) return ctx.reply('Send: /stats <contractAddress>');

  const ca = caRaw.toLowerCase();
  const data = await ensureData(ca);
  if (!data) return ctx.reply('Initializing… try again in a few seconds.');

  const { text, extra } = renderOverview(data);
  return ctx.replyWithMarkdownV2(text, { ...extra, disable_web_page_preview: true });
});

// /refresh <ca> — Manual refresh with cooldown
bot.command('refresh', async (ctx) => {
  const [, caRaw] = ctx.message.text.trim().split(/\s+/);
  if (!isAddress(caRaw)) return ctx.reply('Send: /refresh <contractAddress>');

  const ca = caRaw.toLowerCase();
  const res = await requestRefresh(ca);
  if (!res.ok) {
    return ctx.reply(`Recently refreshed (${res.age.toFixed(0)}s ago). Try again shortly.`);
  }
  return ctx.reply(`Refreshing ${ca}…`);
});

// --- Callback actions (inline keyboard navigation) ---

bot.action(/^(stats|buyers|holders|refresh):/, async (ctx) => {
  try {
    const [kind, ca, maybePage] = ctx.callbackQuery.data.split(':');

    if (kind === 'refresh') {
      const res = await requestRefresh(ca);
      const msg = res.ok
        ? 'Refreshing…'
        : `Recently refreshed (${res.age.toFixed(0)}s ago). Try again shortly.`;
      return ctx.answerCbQuery(msg, { show_alert: false });
    }

    const data = await ensureData(ca);
    if (!data) {
      return ctx.answerCbQuery('Initializing… try again shortly.', { show_alert: true });
    }

    if (kind === 'stats') {
      const { text, extra } = renderOverview(data);
      return ctx.editMessageText(text, {
        ...extra,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true
      });
    }

    if (kind === 'buyers') {
      const page = Number(maybePage || 1);
      const { text, extra } = renderBuyers(data, page);
      return ctx.editMessageText(text, {
        ...extra,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true
      });
    }

    if (kind === 'holders') {
      const page = Number(maybePage || 1);
      const { text, extra } = renderHolders(data, page);
      return ctx.editMessageText(text, {
        ...extra,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true
      });
    }
  } catch (e) {
    return ctx.answerCbQuery('Error — try again', { show_alert: true });
  }
});

// --- Boot ---

bot.launch().then(() => console.log('tABS Tools bot up.'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
