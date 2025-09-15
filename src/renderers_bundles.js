// src/renderers_bundles.js
import { esc, shortAddr } from './ui_html.js';

export function renderBundlesView(summary, bundles) {
  const name = esc(summary?.market?.name || 'Token');
  const ca   = summary?.tokenAddress;

  const header = [
    `🧺 <b>Bundles — ${name}</b>`,
    `<code>${esc(ca)}</code>`,
    ``
  ];

  let body = '';
  if (!bundles || !bundles.groups?.length) {
    body = '<i>No buyer bundles detected in the first 100 buys.</i>';
  } else {
    const lines = [];
    lines.push(`Detected <b>${bundles.totalBundles}</b> bundle group(s) among the first 100 buys.`);
    lines.push('');
    bundles.groups.slice(0, 10).forEach((g, i) => {
      const buyers = g.buyers.map(a => `<code>${esc(shortAddr(a))}</code>`).join(', ');
      lines.push(`${i+1}. <b>${g.size} wallets</b> — ~${g.sharePct}% of early volume`);
      lines.push(`   ${buyers}${g.buyers.length===10?'…':''}`);
      lines.push('');
    });
    body = lines.join('\n');
  }

  const text = [...header, body, ``, `<i>Updated: ${new Date(bundles?.updatedAt || Date.now()).toLocaleString()}</i>`].join('\n');

  const extra = {
    reply_markup: {
      inline_keyboard: [
        [{ text:'🏠 Overview', callback_data:`stats:${ca}` }],
      ]
    },
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };

  return { text, extra };
}
