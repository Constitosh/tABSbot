// src/bot.js
import './configEnv.js';
import { Telegraf } from 'telegraf';
import { queue } from './queueCore.js';
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

// edit caption safely when the message is a photo
const editCaptionHTML = async (ctx, caption, extra = {}) => {
  try {
    return await ctx.editMessageCaption(caption, {
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

// send overview with optional token logo photo; fallback to text if photo fails
const sendOverview = async (ctx, { text, extra, photo }) => {
  if (photo) {
    try {
      return await ctx.replyWithPhoto(photo, {
        caption: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...extra,
      });
    } catch (e) {
      // fallback to text
      console.warn('[BOT] replyWithPhoto failed; falling back to text:', e?.message || e);
    }
  }
  return sendHTML(ctx, text, extra);
};

// ----- Data helpers -----
// Get from cache; if empty, enqueue a refresh and return null.
async function ensureData(ca) {
  const key = `token:${ca}:summary`;
  const cache = await getJSON(key);
  if (cache) return cache;

  try {
    await queue.add('refresh', { tokenAddress: ca }, { removeOnComplete: true, removeOnFail: true });
  } catch (_) {}
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
  try {
    const [, caRaw] = ctx.message.text.trim().split(/\s+/);
    if (!isAddress(caRaw)) return ctx.reply('Send: /stats <contractAddress>');

    const ca = caRaw.toLowerCase();
    const data = await ensureData(ca);
    if (!data) return ctx.reply('Initializing… try again in a few seconds.');

    const { text, extra } = renderOverview(data);
    const photo = data?.market?.info?.imageUrl || null;
    return await sendOverview(ctx, { text, extra, photo });
  } catch (e) {
    console.error('[BOT] /stats error:', e);
    return ctx.reply('Error — try again.');
  }
});

// /refresh <ca>
bot.command('refresh', async (ctx) => {
  try {
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
  } catch (e) {
    console.error('[BOT] /refresh error:', e);
    return ctx.reply('Error — try again.');
  }
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
      const photo = data?.market?.info?.imageUrl || null;

      // does the current message have a photo?
      const hasPhoto =
        !!ctx.callbackQuery?.message?.photo?.length ||
        ctx.callbackQuery?.message?.caption?.length > 0;

      if (hasPhoto && !photo) {
        // message is a photo but we don't have a new one — just edit the caption
        return await editCaptionHTML(ctx, text, extra);
      }

      if (!hasPhoto && photo) {
        // current message is text-only, we want to show a photo — delete & send fresh
        try { await ctx.deleteMessage(); } catch (_) {}
        return await sendOverview(ctx, { text, extra, photo });
      }

      if (hasPhoto && photo) {
        // keep existing image, update caption (simplest & fast)
        return await editCaptionHTML(ctx, text, extra);
      }

      // both are text-only
      return await editHTML(ctx, text, extra);
    }

    if (kind === 'buyers') {
      const page = Number(maybePage || 1);
      const { text, extra } = renderBuyers(data, page);
      return await editHTML(ctx, text, extra);
    }

    if (kind === 'holders') {
      const page = Number(maybePage || 1);
      const { text, extra } = renderHolders(data, page);
      return await editHTML(ctx, text, extra);
    }
  } catch (e) {
    console.error('[BOT] action error:', e);
    return ctx.answerCbQuery('Error — try again', { show_alert: true });
  }
});

// About
bot.action('about', async (ctx) => {
  try {
    const { text, extra } = renderAbout();
    return await editHTML(ctx, text, extra);
  } catch (e) {
    console.error('[BOT] about error:', e);
    return ctx.answerCbQuery('Error — try again', { show_alert: true });
  }
});

// Global error logging
bot.catch((err, ctx) => {
  console.error('[BOT] error for update', ctx?.update?.update_id, err);
});

bot.telegram.getMe()
  .then(me => console.log(`[BOT] up as @${me.username} (${me.id})`))
  .catch(console.error);

bot.launch().then(() => console.log('tABS Tools bot up (polling).'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
