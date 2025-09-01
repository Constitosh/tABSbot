// src/bot.js
import './configEnv.js';
import { Telegraf } from 'telegraf';
import { queue } from './queueCore.js';
import { getJSON, setJSON } from './cache.js';
import { renderOverview, renderBuyers, renderHolders, renderAbout } from './renderers.js';
import { isAddress } from './util.js';

const bot = new Telegraf(process.env.BOT_TOKEN);

// --------- tiny helpers ----------
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
    if (desc.includes('message is not modified')) return ctx.answerCbQuery('Already up to date');
    throw err;
  }
};

// --------- noisy logging middleware (for debugging) ----------
bot.use(async (ctx, next) => {
  try {
    const t = ctx.updateType;
    const msg = ctx.message?.text || ctx.callbackQuery?.data || '';
    console.log('[BOT] update:', t, msg);
  } catch {}
  return next();
});

// --------- cache/queue helpers ----------
async function ensureData(ca) {
  const key = `token:${ca}:summary`;
  const cache = await getJSON(key);
  if (cache) {
    console.log('[BOT] cache hit', key);
    return cache;
  }
  console.log('[BOT] cache miss', key, '— enqueue refresh');
  try {
    await queue.add('refresh', { tokenAddress: ca }, { removeOnComplete: true, removeOnFail: true });
  } catch (e) {
    console.error('[BOT] enqueue failed', e?.message || e);
  }
  return null;
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

// --------- commands ----------
bot.start((ctx) =>
  ctx.reply(
    [
      'tABS Tools ready.',
      'Use /stats <contract>  •  /refresh <contract>',
      'Example: /stats 0x1234567890abcdef1234567890abcdef12345678',
      'Debug: /ping • /id',
    ].join('\n')
  )
);

bot.command('ping', (ctx) => ctx.reply('pong ✅'));

bot.command('id', (ctx) => ctx.reply(`chat id: ${ctx.chat?.id}`));

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

// callbacks
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
    console.error('[BOT] action error', e);
    return ctx.answerCbQuery('Error — try again', { show_alert: true });
  }
});

bot.action('about', async (ctx) => {
  const { text, extra } = renderAbout();
  return editHTML(ctx, text, extra);
});

// --------- boot (ensure polling; kill webhook) ----------
(async () => {
  try {
    const me = await bot.telegram.getMe();
    console.log(`[BOT] token ok: @${me.username} (${me.id})`);
    // kill any webhook, so polling works
    await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
    await bot.launch({ dropPendingUpdates: true });
    console.log('tABS Tools bot up (polling).');
  } catch (err) {
    console.error('[BOT] launch error', err);
    process.exit(1);
  }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Global error logging
process.on('unhandledRejection', (e) => console.error('[BOT] unhandledRejection', e));
process.on('uncaughtException', (e) => console.error('[BOT] uncaughtException', e));
