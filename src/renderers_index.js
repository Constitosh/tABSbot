// src/renderers_index.js
import { esc, pct } from './ui_html.js';

// tiny ascii bar (0..10)
function bar10(frac) {
  const f = Math.max(0, Math.min(1, Number(frac||0)));
  const filled = Math.round(f*10);
  return `[${'█'.repeat(filled)}${'░'.repeat(10-filled)}]`;
}

function buckLabel(min, max) {
  const fmt = (x)=> `&#36;${x.toLocaleString()}`; // escape $
  if (max === Infinity) return `${fmt(min)}+`;
  return `${fmt(min)}–${fmt(max)}`;
}

/**
 * Render the Index screen.
 * `data` can be:
 *   - null/undefined        -> not ready
 *   - { ready:false }       -> not ready
 *   - { ready:true, data }  -> payload from indexWorker
 */
export function renderIndexView(tokenSummary, indexResult) {
  const ca = esc(tokenSummary?.tokenAddress || '');

  // --- not ready yet ---
  if (!indexResult || !indexResult.ready) {
    const text = [
      `📈 <b>Index</b>`,
      ``,
      `<i>Holder distribution is being prepared…</i>`,
      ``,
      `This runs once and is cached for 6 hours.`,
    ].join('\n');

    const kb = {
      reply_markup: {
        inline_keyboard: [
          [
            { text:'🏠 Overview', callback_data:`stats:${tokenSummary?.tokenAddress}` },
            { text:'🧑‍🤝‍🧑 Buyers', callback_data:`buyers:${tokenSummary?.tokenAddress}:1` },
            ...(Array.isArray(tokenSummary?.holdersTop20) && tokenSummary.holdersTop20.length
              ? [{ text:'📊 Holders', callback_data:`holders:${tokenSummary.tokenAddress}:1` }]
              : [])
          ]
        ]
      }
    };
    return { text, extra: kb };
  }

  const idx = indexResult.data || {};
  const gini = Number(idx.gini || 0);

  // choose 6 value buckets based on market cap (fallback if missing)
  const mc = Number(tokenSummary?.market?.marketCap || tokenSummary?.market?.fdv || 0);
  // heuristic buckets
  let cuts = [10, 50, 100, 250, 1000, 2500];
  if (mc > 200_000) cuts = [25, 100, 250, 500, 2500, 5000];
  if (mc > 1_000_000) cuts = [50, 250, 500, 1000, 5000, 10000];

  // We only have percent-of-supply; we’ll map to value roughly using price (if available)
  const price = Number(tokenSummary?.market?.priceUsd || 0);
  // If price is 0, we still display supply-percent histogram + gini text.

  // Simple supply-percent histogram using fixed bands
  const bands = [
    { label:'<0.01%',  max:0.01 },
    { label:'<0.05%',  max:0.05 },
    { label:'<0.10%',  max:0.10 },
    { label:'<0.50%',  max:0.50 },
    { label:'<1.00%',  max:1.00 },
    { label:'≥1.00%',  max:Infinity },
  ];
  const percs = Array.isArray(idx.holdersAllPerc) ? idx.holdersAllPerc : [];
  const bandCounts = bands.map((b,i)=>{
    let cnt = 0;
    for (const p of percs) {
      if (i < bands.length - 1) {
        if (p > 0 && p < b.max) cnt++;
      } else {
        if (p >= 1.0) cnt++;
      }
    }
    return cnt;
  });
  const totalH = Number(idx.holdersCount || 0);
  const bandLines = bands.map((b,i)=>{
    const frac = totalH>0 ? bandCounts[i]/totalH : 0;
    return `• ${esc(b.label)} — ${bandCounts[i]} ${bar10(frac)}`;
  });

  // Value buckets (if we have price)
  let valueLines = [];
  if (price > 0) {
    // assume an “average holder tokens” approximation from percent (this is rough but consistent)
    // token value per holder ~= (percent_of_supply/100) * (FDV or MC)
    const cap = mc > 0 ? mc : 0;
    const buckDefs = [
      { min: 0, max: cuts[0] },
      { min: cuts[0], max: cuts[1] },
      { min: cuts[1], max: cuts[2] },
      { min: cuts[2], max: cuts[3] },
      { min: cuts[3], max: cuts[4] },
      { min: cuts[4], max: Infinity },
    ];
    const counts = new Array(6).fill(0);
    for (const p of percs) {
      if (p <= 0) continue;
      const estValue = (cap>0) ? (p/100) * cap : 0;
      const idxBuck = buckDefs.findIndex(b => estValue >= b.min && estValue < b.max);
      counts[idxBuck < 0 ? 0 : idxBuck]++;
    }
    valueLines = buckDefs.map((b,i)=>{
      const frac = totalH>0 ? counts[i]/totalH : 0;
      return `• ${buckLabel(b.min, b.max)} — ${counts[i]} ${bar10(frac)}`;
    });
  }

  const text = [
    `📈 <b>Index</b>`,
    ``,
    `Holders: <b>${(idx.holdersCount||0).toLocaleString()}</b>`,
    `Top-10 combined: <b>${esc(pct(idx.top10CombinedPct||0))}</b>`,
    `Inequality (Gini): <b>${gini.toFixed(4)}</b> <i>(0=fair • 1=concentrated)</i>`,
    ``,
    `<b>Distribution by % of supply</b>`,
    ...bandLines,
    ``,
    ...(valueLines.length
      ? [`<b>Distribution by estimated value</b>`, ...valueLines, ``]
      : []),
    `<i>Snapshot cached for ~6h.</i>`,
  ].join('\n');

  const kb = {
    reply_markup: {
      inline_keyboard: [
        [
          { text:'🏠 Overview', callback_data:`stats:${tokenSummary?.tokenAddress}` },
          { text:'🧑‍🤝‍🧑 Buyers', callback_data:`buyers:${tokenSummary?.tokenAddress}:1` },
          ...(Array.isArray(tokenSummary?.holdersTop20) && tokenSummary.holdersTop20.length
            ? [{ text:'📊 Holders', callback_data:`holders:${tokenSummary.tokenAddress}:1` }]
            : [])
        ]
      ]
    }
  };
  return { text, extra: kb };
}