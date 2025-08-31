// src/bot.js
import './configEnv.js';
import { Telegraf } from 'telegraf';
import { queue } from './queueCore.js';          // only queue
import { getJSON, setJSON } from './cache.js';
import { renderOverview, renderBuyers, renderHolders, renderAbout } from './renderers.js';
import { isAddress } from './util.js';

const bot = new Telegraf(process.env.BOT_TOKEN);

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
      return ctx.answerCbQuery('Already up to date');
    }
    throw err;
  }
};

// ----- Data helpers -----
// Enqueue refresh if missing and poll Redis briefly for the summary
// ----- Data helpers -----
async function ensureData(ca) {
  const key = `token:${ca}:summary`;
  const cache = await getJSON(key);
  if (cache) return cache;

  // cache miss → enqueue a refresh and return null
  try {
    // throttle: set last_refresh to now so requestRefresh sees it
    await setJSON(`token:${ca}:last_refresh`, { ts: Date.now() }, 600);
    await queue.add('refresh', { tokenAddress: ca }, { removeOnComplete: true, removeOnFail: true });
  } catch (_) {}
  return null;
}
  // 1) fast path: cached
  const cached = await getJSON(key);
  if (cached) return cached;

  // 2) gate + enqueue
  const last = await getJSON(gateKey);
  const age = last ? (Date.now() - last.ts) / 1000 : Infinity;
  if (!(Number.isFinite(age) && age < 1)) {
    await setJSON(gateKey, { ts: Date.now() }, 600).catch(() => {});
    await queue.add('refresh', { tokenAddress: ca }, { removeOnComplete: true, removeOnFail: true }).catch(() => {});
  }

  // 3) poll Redis for up to ~3s
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const got = await getJSON(key);
    if (got) return got;
    await new Promise(r => setTimeout(r, 250));
  }

  // 4) give up for now
  return null;
}

// Always return { ok:boolean, age?:number, error?:string }
async function requestRefresh(ca) {
  try {
    const gateKey = `token:${ca}:last_refresh`;
    const last = await getJSON(gateKey);
    const age = last ? (Date.now() - last.ts) / 1000 : Infinity;

    if (Number.isFinite(age) && age < 30) {
      return { ok: false, age };
    }
    await setJSON(gateKey, { ts: Date.now() }, 600);
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

bot.command('stats', async (ctx) => {
  const [, caRaw] = ctx.message.text.trim().split(/\s+/);
  if (!isAddress(caRaw)) return ctx.reply('Send: /stats <contractAddress>');
  const ca = caRaw.toLowerCase();

  const data = await ensureData(ca);
  if (!data) return ctx.reply('Initializing… try again in a few seconds.');

  const { text, extra } = renderOverview(data);
  return sendHTML(ctx, text, extra);
});

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
bot.action('noop', (ctx) => ctx.answerCbQuery(''));

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

bot.action('about', async (ctx) => {
  const { text, extra } = renderAbout();
  return editHTML(ctx, text, extra);
});

// ----- Boot -----
bot.launch().then(() => console.log('tABS Tools bot up.'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));