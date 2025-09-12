// src/renderers_index.js
// Renders the “Index” page (holder value distribution + gini + bands)

import { esc, money, pct } from './ui_html.js';

// tiny ascii bar (0–10 blocks)
function bar(count, max) {
  const m = Math.max(1, Number(max || 1));
  const c = Math.max(0, Number(count || 0));
  const fill = Math.round((c / m) * 10);
  return '█'.repeat(fill) + '░'.repeat(10 - fill);
}

function fmtBucketLabel(threshold) {
  // Display like “≤ $50”, “≤ $1000”, last bucket will still be shown with its threshold label
  const t = Number(threshold || 0);
  if (!Number.isFinite(t)) return '≤ $0';
  // Avoid raw $ symbols confusing Telegram entity parsing by wrapping in <code>
  const label = `≤ ${money(t, 0)}`;
  return `<code>${esc(label)}</code>`;
}

// Split summary line for bands
function bandsLine(bandCounts, totalHolders) {
  const t = Math.max(1, Number(totalHolders || 1));
  const bc = bandCounts || {};
  const l001 = bc.lt001 || 0;
  const l005 = bc.lt005 || 0;
  const l01  = bc.lt01  || 0;
  const l05  = bc.lt05  || 0;
  const g1   = bc.gte1  || 0;

  const p = (x)=> pct((x / t) * 100, 2);

  return [
    `<b>By supply share</b>`,
    `• <code>&lt;0.01%</code> — <b>${l001}</b> (${p(l001)})`,
    `• <code>&lt;0.05%</code> — <b>${l005}</b> (${p(l005)})`,
    `• <code>&lt;0.1%</code>  — <b>${l01}</b> (${p(l01)})`,
    `• <code>&lt;0.5%</code>  — <b>${l05}</b> (${p(l05)})`,
    `• <code>&ge;1%</code>   — <b>${g1}</b> (${p(g1)})`,
  ].join('\n');
}

export function renderIndex(indexData) {
  // Minimal guard
  if (!indexData || indexData.ok === false) {
    const reason = indexData?.reason === 'no_price'
      ? 'No price yet (no Abstract pair indexed).'
      : 'Holder distribution not available yet.';
    const text = [
      `📈 <b>Index</b>`,
      ``,
      `<i>${esc(reason)}</i>`,
    ].join('\n');
    return {
      text,
      extra: {
        reply_markup: {
          inline_keyboard: [
            [
              { text:'🏠 Overview', callback_data:`stats:${indexData?.tokenAddress || ''}` },
              { text:'🧑‍🤝‍🧑 Buyers', callback_data:`buyers:${indexData?.tokenAddress || ''}:1` },
              { text:'📊 Holders', callback_data:`holders:${indexData?.tokenAddress || ''}:1` },
            ]
          ]
        }
      }
    };
  }

  const ca = indexData.tokenAddress;
  const m  = indexData.market || {};
  const name = esc(m.name || 'Token');
  const sym  = m.symbol ? ` (${esc(m.symbol)})` : '';
  const px   = Number(m.priceUsd || 0);

  const holders = indexData.holders || {};
  const totalH = Number(holders.count || 0);
  const burned = Number(holders.burnedPct || 0);
  const top10  = Number(holders.top10CombinedPct || 0);

  const vb = indexData.valueBuckets || {};
  const thresholds = Array.isArray(vb.thresholds) ? vb.thresholds : [];
  const counts     = Array.isArray(vb.counts) ? vb.counts : [];
  const above10    = Number(vb.above10 || 0);
  const below10    = Number(vb.below10 || 0);

  const giniUsd = Number(indexData?.gini?.usd || 0);

  const maxCount = counts.length ? Math.max(...counts) : 0;

  // Header
  const header = [
    `📈 <b>Index — ${name}${sym}</b>`,
    `<code>${esc(ca)}</code>`,
    ``,
    `Price: <b>${esc(money(px || 0, 8))}</b>`,
    `Holders: <b>${totalH.toLocaleString()}</b>`,
    `Top 10 combined: <b>${esc(pct(top10, 2))}</b> · Burned: <b>${esc(pct(burned, 2))}</b>`,
    `Gini (USD): <b>${giniUsd.toFixed(4)}</b>  <i>(0=fair · 1=concentrated)</i>`,
    ``,
  ].join('\n');

  // $10+ vs <$10
  const split = [
    `<b>Real holders split</b>`,
    `• <code>&ge; $10</code> — <b>${above10}</b>`,
    `• <code>&lt; $10</code> — <b>${below10}</b>`,
    ``,
  ].join('\n');

  // Histogram (6 buckets)
  let hist = `<b>Value distribution</b>\n`;
  if (thresholds.length && counts.length && thresholds.length === counts.length) {
    for (let i = 0; i < thresholds.length; i++) {
      const label = fmtBucketLabel(thresholds[i]);     // e.g. “≤ $50”
      const c     = Number(counts[i] || 0);
      hist += `${label}  —  <code>${c.toString().padStart(3,' ')}</code>  ${bar(c, maxCount)}\n`;
    }
  } else {
    hist += `<i>No distribution yet.</i>\n`;
  }
  hist += `\n`;

  // Supply bands
  const bands = bandsLine(holders.percBands || {}, totalH);

  // Footer
  const footer = [
    ``,
    `<i>Updated: ${esc(new Date(indexData.updatedAt).toLocaleString())}</i>`,
  ].join('\n');

  const text = [header, split, hist, bands, footer].join('\n');

  const extra = {
    reply_markup: {
      inline_keyboard: [
        [
          { text:'🏠 Overview', callback_data:`stats:${ca}` },
          { text:'🧑‍🤝‍🧑 Buyers', callback_data:`buyers:${ca}:1` },
          { text:'📊 Holders', callback_data:`holders:${ca}:1` },
        ]
      ]
    }
  };

  return { text, extra };
}