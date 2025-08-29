// src/bot.js
import './configEnv.js';
import { Telegraf } from 'telegraf';
import { getJSON, setJSON } from './cache.js';
import { queue, refreshToken } from './queueCore.js';
import { renderOverview, renderBuyers, renderHolders } from './renderers.js';
import { isAddress } from './util.js';

const bot = new Telegraf(process.env.BOT_TOKEN);

// ---- HTML helpers (so we never forget the parse_mode) ----
const sendHTML = (ctx, text, extra={}) =>
  ctx.replyWithHTML(text, { disable_web_page_preview: true, ...extra });

const editHTML = (ctx, text, extra={}) =>
  ctx.editMessageText(text, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

// ---- data helpers ----
async function ensureData(ca) { /* ...unchanged... */ }
async function requestRefresh(ca) { /* ...unchanged... */ }

// ---- Commands ----
bot.start((ctx) => ctx.reply(
  'tABS Tools ready.\nUse /stats <contract>  •  /refresh <contract>\nExample: /stats 0x1234567890abcdef1234567890abcdef12345678'
));

bot.command('stats', async (ctx) => {
  const [, caRaw] = ctx.message.text.trim().split(/\s+/);
  if (!isAddress(caRaw)) return ctx.reply('Send: /stats <contractAddress>');
  const ca = caRaw.toLowerCase();

  const data = await ensureData(ca);
  if (!data) return ctx.reply('Initializing… try again in a few seconds.');

  const { text, extra } = renderOverview(data);
  return sendHTML(ctx, text, extra);  // 👈 use HTML helper
});

bot.command('refresh', async (ctx) => {
  const [, caRaw] = ctx.message.text.trim().split(/\s+/);
  if (!isAddress(caRaw)) return ctx.reply('Send: /refresh <contractAddress>');
  const ca = caRaw.toLowerCase();

  const res = await requestRefresh(ca);
  if (!res.ok) return ctx.reply(`Recently refreshed (${res.age.toFixed(0)}s ago). Try again shortly.`);
  return ctx.reply(`Refreshing ${ca}…`);
});

// ---- Callbacks ----
bot.action(/^(stats|buyers|holders|refresh):/, async (ctx) => {
  try {
    const [kind, ca, maybePage] = ctx.callbackQuery.data.split(':');

    if (kind === 'refresh') {
      const res = await requestRefresh(ca);
      const msg = res.ok ? 'Refreshing…' : `Recently refreshed (${res.age.toFixed(0)}s ago). Try again shortly.`;
      return ctx.answerCbQuery(msg, { show_alert: false });
    }

    const data = await ensureData(ca);
    if (!data) return ctx.answerCbQuery('Initializing… try again shortly.', { show_alert: true });

    if (kind === 'stats') {
      const { text, extra } = renderOverview(data);
      return editHTML(ctx, text, extra);   // 👈 HTML
    }

    if (kind === 'buyers') {
      const page = Number(maybePage || 1);
      const { text, extra } = renderBuyers(data, page);
      return editHTML(ctx, text, extra);   // 👈 HTML
    }

    if (kind === 'holders') {
      const page = Number(maybePage || 1);
      const { text, extra } = renderHolders(data, page);
      return editHTML(ctx, text, extra);   // 👈 HTML
    }
  } catch (e) {
    return ctx.answerCbQuery('Error — try again', { show_alert: true });
  }
});

bot.launch().then(() => console.log('tABS Tools bot up.'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
