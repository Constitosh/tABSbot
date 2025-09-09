// src/renderers_bundles.js
import { esc, shortAddr } from './ui_html.js';

export function renderBundlesView(data) {
  if (!data || !Array.isArray(data.clusters) || data.clusters.length === 0) {
    const text = [
      `🧵 <b>Bundle scan</b>`,
      ``,
      `No suspicious funding clusters found among the first 100 buyers.`,
      `<i>Updated: ${esc(new Date(Date.now()).toLocaleString())}</i>`
    ].join('\n');
    return { text, extra: { reply_markup: { inline_keyboard: [[{ text:'🏠 Overview', callback_data:`stats:${data?.tokenAddress||'noop'}` }]] } } };
  }

  const lines = [];
  lines.push(`🧵 <b>Bundle scan</b>`);
  lines.push(`First 100 buyers clustered by <i>funding wallet</i> (EOA that sent native ETH before the first buy).`);
  lines.push(`Threshold: ≥3 funded buyers.\n`);

  data.clusters.forEach((c, idx) => {
    lines.push(`${String(idx+1).padStart(2,'0')}. <code>${esc(shortAddr(c.funder))}</code> — <b>${c.count}</b> buyers`);
    const sample = c.buyers.slice(0, 6).map(a => `<code>${esc(shortAddr(a))}</code>`).join('  ');
    lines.push(`    ${sample}${c.buyers.length>6 ? ' …' : ''}`);
  });

  lines.push(`\n<i>Computed: ${esc(new Date(data.computedAt).toLocaleString())}</i>`);

  const text = lines.join('\n');
  const extra = {
    reply_markup: {
      inline_keyboard: [
        [{ text:'↻ Rescan', callback_data:`bundles_refresh:${data.tokenAddress}` }],
        [{ text:'🏠 Overview', callback_data:`stats:${data.tokenAddress}` }]
      ]
    }
  };
  return { text, extra };
}
