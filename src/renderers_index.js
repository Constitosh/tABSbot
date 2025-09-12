// src/renderers_index.js
import { esc } from './ui_html.js';

/* ---------- helpers ---------- */

// Escape labels that may contain "<" or ">" so Telegram HTML parser doesn’t choke
function safeLabel(s) {
  return esc(String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'));
}

// Common nav keyboard used on Index screen
function navKB(ca) {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text:'🏠 Overview',     callback_data:`stats:${ca}` },
        { text:'🧑‍🤝‍🧑 Buyers',  callback_data:`buyers:${ca}:1` },
        { text:'📊 Holders',      callback_data:`holders:${ca}:1` },
      ], [
        // tapping Index again re-runs the compute (or pulls from cache)
        { text:'↻ Rebuild',       callback_data:`index:${ca}` },
      ]]
    }
  };
}

/* ---------- public renderers ---------- */

// Loading screen used right after clicking “Index”
export function renderIndexLoading(ca) {
  const text = [
    '📈 <b>Index</b>',
    '',
    '<i>Crunching holder distribution…</i>',
    '<i>This will be cached for ~6h once ready.</i>',
  ].join('\n');
  return { text, extra: navKB(ca) };
}

// Fallback if nothing is available yet
export function renderIndexUnavailable(ca, reason = '') {
  const msg = reason ? `<i>${esc(reason)}</i>` : '<i>Holder distribution not available yet.</i>';
  const text = [
    '📈 <b>Index</b>',
    '',
    msg,
    '<i>Tap “↻ Rebuild” to try again.</i>'
  ].join('\n');
  return { text, extra: navKB(ca) };
}

// Main renderer — expects the payload returned by refreshIndex()
export function renderIndex(idxPayload) {
  if (!idxPayload || !idxPayload.data) {
    // keep UX graceful if caller forgot to gate on data presence
    const ca = idxPayload?.tokenAddress || '0x';
    return renderIndexUnavailable(ca);
  }

  const ca = idxPayload.tokenAddress;
  const d  = idxPayload.data;

  const holders = Number(d.holdersCount || 0);
  const top10   = Number(d.top10CombinedPct || 0);
  const gini    = Number(d.gini || 0);

  const supplyDist = Array.isArray(d.supplyDist) ? d.supplyDist : [];
  const valueDist  = Array.isArray(d.valueDist)  ? d.valueDist  : [];

  // Show that buckets cover 100% of the included holder set
  const supSum = supplyDist.reduce((a, b) => a + (Number(b.count) || 0), 0);
  const valSum = valueDist.reduce((a, b) => a + (Number(b.count) || 0), 0);

  const lines = [
    '📈 <b>Index</b>',
    '',
    `Holders: <b>${holders.toLocaleString()}</b>`,
    `Top-10 combined: <b>+${top10.toFixed(2)}%</b>`,
    `Inequality (Gini): <b>${gini.toFixed(4)}</b> <i>(0=fair • 1=concentrated)</i>`,
    '',
    'Distribution by % of supply',
    ...(supplyDist.length
      ? supplyDist.map(b => `• ${safeLabel(b.label)} — <b>${Number(b.count)||0}</b> ${b.bar || ''}`)
      : ['<i>No distribution yet.</i>']),
    (holders > 0
      ? `↳ <i>Buckets cover ${supSum}/${holders} holders (100% of included set).</i>`
      : ''),
    '',
    'Distribution by estimated value',
    ...(valueDist.length
      ? valueDist.map(b => `• ${safeLabel(b.label)} — <b>${Number(b.count)||0}</b> ${b.bar || ''}`)
      : ['<i>No pricing yet.</i>']),
    (holders > 0
      ? `↳ <i>Buckets cover ${valSum}/${holders} holders (100% of included set).</i>`
      : ''),
    '',
    '<i>LP addresses, burn addresses, and token-as-pool (Moonshot bonding) are excluded everywhere.</i>',
    '<i>Snapshot cached for ~6h.</i>',
  ].filter(Boolean);

  return { text: lines.join('\n'), extra: navKB(ca) };
}
