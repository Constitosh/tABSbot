// src/renderers_pnl.js
// Shows wallet balance at top + filters open positions under $0.10

import { esc } from './ui_html.js';

const money = (n, dec = 2) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return '$0';
  return '$' + x.toFixed(dec);
};
const to4 = (x) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return '0.0000';
  const s = n.toFixed(4);
  return s.replace(/-0\.0000/g, '0.0000');
};
const pct = (x) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return '0.00%';
  const s = n.toFixed(2) + '%';
  return s.replace(/-0\.00%/g, '0.00%');
};
const shortAddr = (a) => (a ? (a.slice(0,6)+'…'+a.slice(-4)) : '');

function sortByPnlDesc(list) {
  return [...(list || [])].sort((a,b) => Number(b.pnlPct||0) - Number(a.pnlPct||0));
}
function sortByPnlAsc(list) {
  return [...(list || [])].sort((a,b) => Number(a.pnlPct||0) - Number(b.pnlPct||0));
}

function headerButtons(wallet, window) {
  return [
    [
      { text: '📈 Profits', callback_data: `pnlv:${wallet}:${window}:profits` },
      { text: '📉 Losses',  callback_data: `pnlv:${wallet}:${window}:losses` },
    ],
    [
      { text: '📦 Open',    callback_data: `pnlv:${wallet}:${window}:open` },
      { text: '🎁 Airdrops',callback_data: `pnlv:${wallet}:${window}:airdrops` },
    ],
    [
      { text: '↻ Refresh',  callback_data: `pnl_refresh:${wallet}:${window}` }
    ]
  ];
}

function blockOverview(data, window) {
  const lines = [];
  lines.push(`💼 <b>Wallet PnL — ${esc(shortAddr(data.wallet))}</b>`);
  lines.push(`Window: ${esc(window)}`);

  // NEW: Wallet balance on top (then a blank line)
  {
    const balEth  = Number(data.walletEth || 0);
    const balWeth = Number(data.walletWeth || 0);
    const balTot  = Number(data.walletEthTotal || (balEth + balWeth));
    lines.push(`💰 Wallet Balance: <b>${to4(balTot)}</b> ETH${balWeth ? ` <i>(incl WETH ${to4(balWeth)})</i>` : ''}`);
    lines.push('');
  }

  // The rest stays as before
  lines.push(`💧 ETH IN: <b>${to4(data.ethIn || 0)}</b> ETH`);
  lines.push(`🔥 ETH OUT: <b>${to4(data.ethOut || 0)}</b> ETH`);
  lines.push(`📈 Realized: <b>${to4(data.realizedEth || 0)}</b> ETH`);
  lines.push(`📊 Unrealized: <b>${to4(data.unrealizedEth || 0)}</b> ETH`);
  lines.push(`📦 Holdings: <b>${money(data.holdingsUsd || 0)}</b>`);
  lines.push(`🎁 Airdrops: <b>${money(data.airdropsUsd || 0)}</b>`);

  const sign = Number(data.totalPnlEth || 0) >= 0 ? '🟢' : '🔴';
  const totalPnlLine = `${sign} Total PnL: <b>${to4(data.totalPnlEth || 0)}</b> ETH  (${sign} ${pct(data.totalPnlPct || 0)})`;
  lines.push(totalPnlLine);
  lines.push('');

  // Top 3 profits & losses
  const topP = sortByPnlDesc(data.topProfits || []).slice(0,3);
  const topL = sortByPnlAsc(data.topLosses || []).slice(0,3);

  lines.push(`<b>Top Profits (realized)</b>`);
  if (!topP.length) {
    lines.push(`<i>No items</i>`);
  } else {
    for (const r of topP) {
      const s = Number(r.pnlEth || 0) >= 0 ? '🟢' : '🔴';
      lines.push(`• ${esc(r.symbol || r.ticker || r.ca || 'Token')} — ${s}`);
      lines.push(`${s} <b>${to4(r.pnlEth || 0)} ETH</b> (${s} ${pct(r.pnlPct || 0)})`);
      lines.push(`Bought ${to4(r.buyEth || 0)} ETH`);
      lines.push(`Sold ${to4(r.sellEth || 0)} ETH`);
      lines.push('');
    }
  }

  lines.push(`<b>Top Losses (realized)</b>`);
  if (!topL.length) {
    lines.push(`<i>No items</i>`);
  } else {
    for (const r of topL) {
      const s = Number(r.pnlEth || 0) >= 0 ? '🟢' : '🔴';
      lines.push(`• ${esc(r.symbol || r.ticker || r.ca || 'Token')} — ${s}`);
      lines.push(`${s} <b>${to4(r.pnlEth || 0)} ETH</b> (${s} ${pct(r.pnlPct || 0)})`);
      lines.push(`Bought ${to4(r.buyEth || 0)} ETH`);
      lines.push(`Sold ${to4(r.sellEth || 0)} ETH`);
      lines.push('');
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function blockProfits(data) {
  const rows = sortByPnlDesc(data.topProfits || []);
  const out = [];
  out.push(`<b>Top Profits (realized) — ${esc(shortAddr(data.wallet))}</b>`);
  out.push('');
  if (!rows.length) {
    out.push('<i>No items</i>');
  } else {
    for (const r of rows) {
      const s = Number(r.pnlEth || 0) >= 0 ? '🟢' : '🔴';
      out.push(`• ${esc(r.symbol || r.ticker || r.ca || 'Token')} — ${s}`);
      out.push(`${s} <b>${to4(r.pnlEth || 0)} ETH</b> (${s} ${pct(r.pnlPct || 0)})`);
      out.push(`Bought ${to4(r.buyEth || 0)} ETH`);
      out.push(`Sold ${to4(r.sellEth || 0)} ETH`);
      out.push('');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function blockLosses(data) {
  const rows = sortByPnlAsc(data.topLosses || []);
  const out = [];
  out.push(`<b>Top Losses (realized) — ${esc(shortAddr(data.wallet))}</b>`);
  out.push('');
  if (!rows.length) {
    out.push('<i>No items</i>');
  } else {
    for (const r of rows) {
      const s = Number(r.pnlEth || 0) >= 0 ? '🟢' : '🔴';
      out.push(`• ${esc(r.symbol || r.ticker || r.ca || 'Token')} — ${s}`);
      out.push(`${s} <b>${to4(r.pnlEth || 0)} ETH</b> (${s} ${pct(r.pnlPct || 0)})`);
      out.push(`Bought ${to4(r.buyEth || 0)} ETH`);
      out.push(`Sold ${to4(r.sellEth || 0)} ETH`);
      out.push('');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function blockOpen(data) {
  const out = [];
  out.push(`<b>Open Positions — ${esc(shortAddr(data.wallet))}</b>`);
  out.push('');

  const OPEN_USD_MIN = 0.10; // NEW: filter out <$0.10
  const rows = (data.openPositions || [])
    .filter(p => Number(p.valueUsd ?? p.usd ?? 0) >= OPEN_USD_MIN);

  if (!rows.length) {
    out.push('<i>No open positions</i>');
  } else {
    for (const r of rows) {
      const name = esc(r.symbol || r.ticker || r.ca || 'Token');
      const amt  = Number(r.amount || r.qty || 0);
      const usd  = Number(r.valueUsd ?? r.usd ?? 0);
      out.push(`• ${name}`);
      out.push(`Holdings: <b>${amt.toLocaleString(undefined, { maximumFractionDigits: 4 })}</b>`);
      out.push(`Value: <b>${money(usd, 2)}</b>`);
      out.push('');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function blockAirdrops(data) {
  const out = [];
  out.push(`<b>Airdrops — ${esc(shortAddr(data.wallet))}</b>`);
  out.push('');
  const rows = data.airdrops || [];
  if (!rows.length) {
    out.push('<i>No airdrops</i>');
  } else {
    for (const r of rows) {
      const kind = r.type === 'nft' ? 'NFT' : 'Token';
      const name = esc(r.name || r.collection || 'Airdrop');
      const qty  = Number(r.qty || r.count || 0);
      const usd  = Number(r.usd || r.valueUsd || 0);
      out.push(`• ${name} (${kind})`);
      out.push(`Qty: <b>${qty}</b>  ·  Value: <b>${money(usd, 2)}</b>`);
      out.push('');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function renderPNL(data, window = '30d', view = 'overview') {
  const wallet = data.wallet;
  const lines =
    view === 'profits' ? blockProfits(data)
  : view === 'losses'  ? blockLosses(data)
  : view === 'open'    ? blockOpen(data)
  : view === 'airdrops'? blockAirdrops(data)
  : blockOverview(data, window);

  const extra = {
    reply_markup: { inline_keyboard: headerButtons(wallet, window) },
    disable_web_page_preview: true,
    parse_mode: 'HTML',
  };
  return { text: lines, extra };
}
