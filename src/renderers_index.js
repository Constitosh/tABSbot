// src/renderers_index.js
import { esc, pct } from './ui_html.js';

// tiny ascii bar (0..10)
function bar10(frac) {
  const f = Math.max(0, Math.min(1, Number(frac||0)));
  const filled = Math.round(f*10);
  return `[${'█'.repeat(filled)}${'░'.repeat(10-filled)}]`;
}

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
  const lpNote = idx.lpExcluded ? ' (LP excluded)' : '';

  const text = [
    `📈 <b>Index</b>`,
    ``,
    `Holders: <b>${(idx.holdersCount||0).toLocaleString()}</b>`,
    `Top-10 combined: <b>${esc(pct(idx.top10CombinedPct||0))}</b>${lpNote}`,
    `Inequality (Gini): <b>${gini.toFixed(4)}</b>${lpNote} <i>(0=fair • 1=concentrated)</i>`,
    ``,
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
        ],
        ...(idx.lpAddress ? [[
          { text:`LP ${String(idx.lpAddress).slice(0,6)}…${String(idx.lpAddress).slice(-4)}`, callback_data:'noop' }
        ]] : [])
      ]
    }
  };
  return { text, extra: kb };
}
