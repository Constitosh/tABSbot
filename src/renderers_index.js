// --- DROP-IN: safe Index renderer ---
// Requires: esc, money helpers already imported in this file

export function renderIndexView(s) {
  // s is the snapshot from ensureIndex()
  const name = esc(s.market?.name || 'Token');
  const sym  = esc(s.market?.symbol || '');
  const ca   = s.tokenAddress;

  const mcUsd   = Number(s.market?.marketCap || s.market?.fdv || 0);
  const holders = Number(s.holdersCount || 0);

  // Build human labels (IMPORTANT: escape "<")
  const bins = s.valueBins || [];         // e.g. [10, 25, 50, 100, 250, 500]
  const counts = s.valueCounts || [];     // length = bins.length + 1
  const vals   = s.valueUsd || [];        // total USD per bucket

  const totalH = counts.reduce((a,b)=>a+b,0) || 1;

  const bar = (n, tot) => {
    // 12-slot bar
    const filled = Math.max(0, Math.min(12, Math.round((n / tot) * 12)));
    return '█'.repeat(filled) + '░'.repeat(12 - filled);
  };

  const num = (x) => (Number(x)||0).toLocaleString();

  const histLines = [];
  for (let i = 0; i <= bins.length; i++) {
    const label = (i < bins.length)
      ? `&lt;$${bins[i]}`                  // <-- ESCAPED "<"
      : `≥$${bins[bins.length - 1]}`;
    const c = counts[i] || 0;
    const v = vals[i] || 0;
    histLines.push(`${label.padEnd(8,' ')} ${bar(c, totalH)}  <b>${num(c)}</b> · ${esc(money(v,2))}`);
  }

  // $10+ vs <$10 split
  const gt10 = Number(s.holdersValueGTE10 || 0);
  const lt10 = Math.max(0, totalH - gt10);

  // Supply bands (escape if any "<")
  const bands = (s.supplyBands || []).map(b => {
    const label = String(b.label || '').replace('<','&lt;');
    return `${label.padEnd(8,' ')} ${bar(b.count || 0, totalH)}  <b>${num(b.count || 0)}</b>`;
  });

  const gini = (typeof s.gini === 'number') ? s.gini.toFixed(3) : 'n/a';

  const lines = [
    `📈 <b>Index — ${name}${sym ? ` (${sym})` : ''}</b>`,
    `<code>${ca}</code>`,
    ``,
    `Market Cap/FDV: <b>${esc(money(mcUsd,0))}</b>`,
    `Holders: <b>${num(holders)}</b>`,
    ``,
    `<b>Value Histogram</b>`,
    ...histLines,
    ``,
    `<b>Holder Types</b>`,
    `≥ $10: <b>${num(gt10)}</b>   ·   &lt; $10: <b>${num(lt10)}</b>`,  // <-- ESCAPED "<"
    ``,
    `<b>Compact Distribution (by % supply)</b>`,
    ...bands,
    ``,
    `Gini (holdings): <b>${gini}</b> — 0 = equal, 1 = concentrated.`,
    ``,
    `<i>Updated: ${new Date(s.updatedAt || Date.now()).toLocaleString()}</i>`,
  ];

  const extra = {
    reply_markup: {
      inline_keyboard: [
        [
          { text:'🏠 Overview', callback_data:`stats:${ca}` },
          { text:'🧑‍🤝‍🧑 Buyers', callback_data:`buyers:${ca}:1` },
          { text:'📊 Holders', callback_data:`holders:${ca}:1` },
        ],
        [
          { text:'↻ Refresh', callback_data:`refresh:${ca}` }
        ]
      ]
    },
    disable_web_page_preview: true,
    parse_mode: 'HTML',
  };

  return { text: lines.join('\n'), extra };
}