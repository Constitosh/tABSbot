// src/renderers_bundles.js
import { esc } from './ui_html.js';

const pct = (n) => (Number.isFinite(n) ? `${n.toFixed(2)}%` : '0.00%');
const short = (a) => (a ? `${a.slice(0,6)}…${a.slice(-4)}` : 'unknown');

export function renderBundles(data, page = 1, pageSize = 8) {
  const name = esc(data.market?.name || 'Token');
  const ca   = data.tokenAddress;
  const info = data.bundles || { groups: [], totals: { buyers:0, bundledWallets:0, uniqueFunders:0, supplyPct:0 } };

  const groups = Array.isArray(info.groups) ? info.groups : [];
  const start  = (page - 1) * pageSize;
  const rows   = groups.slice(start, start + pageSize);

  const header = [
    `📦 <b>Bundles — ${name}</b>`,
    ``,
    `First buyers analyzed: <b>${info.totals?.buyers || 0}</b>`,
    `Bundled wallets: <b>${info.totals?.bundledWallets || 0}</b>`,
    `Unique funders (bundles): <b>${info.totals?.uniqueFunders || 0}</b>`,
    `Supply bought by bundled wallets: <b>${pct(info.totals?.supplyPct || 0)}</b>`,
    ``,
  ].join('\n');

  const body = rows.length ? rows.map((g, i) => {
    const idx = start + i + 1;
    const lines = [];
    lines.push(`${idx}. Funder <code>${esc(short(g.funder))}</code> — <b>${g.buyers}</b> wallets · <b>${esc(pct(g.supplyPct))}</b> of supply`);
    for (const m of (g.members || []).slice(0, 5)) {
      lines.push(`   • <code>${esc(short(m.buyer))}</code> (${esc(pct(m.percentOfSupply || 0))})`);
    }
    if ((g.members || []).length > 5) {
      lines.push(`   … and ${(g.members.length - 5)} more`);
    }
    return lines.join('\n');
  }).join('\n\n') : '<i>No bundles detected.</i>';

  const totalPages = Math.max(1, Math.ceil(groups.length / pageSize));
  const prev = Math.max(1, page - 1);
  const next = Math.min(totalPages, page + 1);

  const text = [
    header,
    body,
    ``,
    `<i>Updated: ${esc(new Date(data.updatedAt).toLocaleString())}</i>  ·  <i>Page ${page}/${totalPages}</i>`
  ].join('\n');

  const prevCb = page > 1 ? `bundles:${ca}:${prev}` : 'noop';
  const nextCb = page < totalPages ? `bundles:${ca}:${next}` : 'noop';

  const extra = {
    reply_markup: {
      inline_keyboard: [
        [
          { text:'◀️', callback_data: prevCb },
          { text:`${page}/${totalPages}`, callback_data:'noop' },
          { text:'▶️', callback_data: nextCb }
        ],
        [
          { text:'🏠 Overview', callback_data:`stats:${ca}` },
          { text:'🧑‍🤝‍🧑 Buyers', callback_data:`buyers:${ca}:1` },
          { text:'📊 Holders',   callback_data:`holders:${ca}:1` },
        ],
      ]
    }
  };

  return { text, extra };
}
