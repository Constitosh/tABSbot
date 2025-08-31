// src/bot.js
import './configEnv.js';
import { Telegraf } from 'telegraf';
import { getJSON, setJSON } from './cache.js';
import { queue, requestRefresh } from './queueCore.js';
import { renderOverview, renderBuyers, renderHolders, renderAbout } from './renderers.js';
import { isAddress } from './util.js';

const bot = new Telegraf(process.env.BOT_TOKEN);

// ----- HTML helpers (ensure consistent parse_mode) -----
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
      return ctx.answerCbQuery('Already up to date');
    }
    throw err;
  }
};

// ----- Data helpers -----
async function ensureData(ca) {
  try {
    const key = `token:${ca}:summary`;
    const cache = await getJSON(key);
    if (cache) return cache;

    // cold start: try a synchronous refresh once
    const fresh = await refreshToken(ca);
    return fresh || null;
  } catch (e) {
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

// ----- Commands -----
bot.start((ctx) =>
  ctx.reply(
    [
      'tABS Tools ready.',
      'Use /stats <contract>  •  /refresh <contract>',
      'Example: /stats 0x1234567890abcdef1234567890abcdef12345678',
    ].join('\n')
  )
);

// /stats <ca>
bot.command('stats', async (ctx) => {
  const [, caRaw] = ctx.message.text.trim().split(/\s+/);
  if (!isAddress(caRaw)) return ctx.reply('Send: /stats <contractAddress>');

  const ca = caRaw.toLowerCase();
  const data = await ensureData(ca);
  if (!data) return ctx.reply('Initializing… try again in a few seconds.');

  const { text, extra } = renderOverview(data);
  return sendHTML(ctx, text, extra);
});

// /refresh <ca>
bot.command('refresh', async (ctx) => {
  const [, caRaw] = ctx.message.text.trim().split(/\s+/);
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

// ----- Callback handlers -----

// noop buttons: just close the spinner
bot.action('noop', (ctx) => ctx.answerCbQuery(''));

// Main action router
bot.action(/^(stats|buyers|holders|refresh):/, async (ctx) => {
  try {
    const [kind, ca, maybePage] = ctx.callbackQuery.data.split(':');

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
    return ctx.answerCbQuery('Error — try again', { show_alert: true });
  }
});

// About modal
bot.action('about', async (ctx) => {
  const { text, extra } = renderAbout();
  return editHTML(ctx, text, extra);
});

// ----- Boot -----
bot.launch().then(() => console.log('tABS Tools bot up.'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
