// src/renderers_pnl.js
import { esc } from './ui_html.js';

// helpers
function fmtEth(x){ return Number(x).toFixed(4); }
function fmtPct(x){ return (Number(x) >= 0 ? '+' : '') + Number(x).toFixed(2) + '%'; }
function money(x){ return '$' + Number(x).toFixed(2); }
function signEmoji(x){ return Number(x) >= 0 ? '🟢' : '🔴'; }
function updown(x){ return Number(x) >= 0 ? '⬆️' : '⬇️'; }

function buttons(wallet, window, view) {
  const tabs = [
    { t:'🏠 Overview', cb:`pnlv:${wallet}:${window}:overview` },
    { t:'📈 Profits',  cb:`pnlv:${wallet}:${window}:profits` },
    { t:'📉 Losses',   cb:`pnlv:${wallet}:${window}:losses` },
    { t:'📦 Open',     cb:`pnlv:${wallet}:${window}:open` },
    { t:'🎁 Airdrops', cb:`pnlv:${wallet}:${window}:airdrops` },
  ];
  return {
    reply_markup: {
      inline_keyboard: [
        tabs.map(b => ({ text:b.t, callback_data:b.cb })),
        [{ text:'↻ Refresh', callback_data:`pnl_refresh:${wallet}:${window}` }]
      ]
    },
    disable_web_page_preview: true,
    parse_mode: 'HTML'
  };
}

function header(data, window) {
  const b = [];
  b.push(`💼 <b>Wallet PnL — ${esc(data.wallet.slice(0,6))}…${esc(data.wallet.slice(-4))}</b>`);
  b.push(`Window: ${esc(window)}`);
  // Wallet ETH (WETH) balance
  const ethStr = (data.walletEthTotal && data.walletEth) ? `${Number(data.walletEthTotal).toFixed(6)} ETH` : `${Number(data.walletEth||0).toFixed(6)} ETH`;
  b.push(`💰 Wallet Balance: ${esc(ethStr)}`);
  b.push(''); // blank line

  const t = data.totals || {};
  const emTotal = signEmoji(t.totalEth || 0);
  const emReal  = signEmoji(t.realizedEth || 0);
  const emUnr   = signEmoji(t.unrealizedEth || 0);

  b.push(`💧 ETH IN: ${fmtEth(t.ethIn || 0)} ETH`);
  b.push(`🔥 ETH OUT: ${fmtEth(t.ethOut || 0)} ETH`);
  b.push(`📈 Realized: ${emReal} ${fmtEth(t.realizedEth || 0)} ETH`);
  b.push(`📊 Unrealized: ${emUnr} ${fmtEth(t.unrealizedEth || 0)} ETH`);
  b.push(`📦 Holdings: ${money(t.holdingsUsd || 0)}`);
  b.push(`🎁 Airdrops: ${money(t.airdropsUsd || 0)}`);
  b.push(`${emTotal} Total PnL: ${fmtEth(t.totalEth || 0)} ETH  (${signEmoji(t.totalPct||0)} ${fmtPct(t.totalPct||0)})`);
  return b.join('\n');
}

/* ---------- Overview ---------- */
export function renderPNL(data, window='30d', view='overview') {
  const wallet = data.wallet;
  const lines = [header(data, window), ''];

  if (view === 'overview') {
    // top 3 profits
    lines.push(`Top Profits (realized)`);
    const prof = (data.topProfits || []).slice(0,3);
    if (!prof.length) lines.push('<i>No realized profits.</i>');
    for (const p of prof) {
      const em = signEmoji(p.realizedEth);
      lines.push(`• ${esc(p.symbol || p.token)} — ${em}`);
      lines.push(`${em} ${fmtEth(p.realizedEth)} ETH (${em} ${fmtPct(p.realizedPct)})`);
      lines.push(`Bought ${fmtEth(p.buyEth)} ETH`);
      lines.push(`Sold ${fmtEth(p.sellEth)} ETH`);
      lines.push(''); // blank line
    }

    // top 3 losses
    lines.push(`Top Losses (realized)`);
    const loss = (data.topLosses || []).slice(0,3);
    if (!loss.length) lines.push('<i>No realized losses.</i>');
    for (const p of loss) {
      const em = signEmoji(p.realizedEth); // will be 🔴
      lines.push(`• ${esc(p.symbol || p.token)} — ${em}`);
      lines.push(`${em} ${fmtEth(p.realizedEth)} ETH (${em} ${fmtPct(p.realizedPct)})`);
      lines.push(`Bought ${fmtEth(p.buyEth)} ETH`);
      lines.push(`Sold ${fmtEth(p.sellEth)} ETH`);
      lines.push(''); // blank line
    }

    return { text: lines.join('\n'), extra: buttons(wallet, window, 'overview') };
  }

  if (view === 'profits') {
    lines.push(`📈 <b>All Realized Profits</b>`);
    const rows = (data.fullProfits || []);
    if (!rows.length) lines.push('<i>No realized profits.</i>');
    for (const p of rows) {
      const em = '🟢';
      lines.push(`• ${esc(p.symbol || p.token)} — ${em}`);
      lines.push(`${em} ${fmtEth(p.realizedEth)} ETH (${em} ${fmtPct(p.realizedPct)})`);
      lines.push(`Bought ${fmtEth(p.buyEth)} ETH`);
      lines.push(`Sold ${fmtEth(p.sellEth)} ETH`);
      lines.push('');
    }
    return { text: lines.join('\n'), extra: buttons(wallet, window, 'profits') };
  }

  if (view === 'losses') {
    lines.push(`📉 <b>All Realized Losses</b>`);
    const rows = (data.fullLosses || []);
    if (!rows.length) lines.push('<i>No realized losses.</i>');
    for (const p of rows) {
      const em = '🔴';
      // realizedEth will be negative; print negative number
      lines.push(`• ${esc(p.symbol || p.token)} — ${em}`);
      lines.push(`${em} ${fmtEth(p.realizedEth)} ETH (${em} ${fmtPct(p.realizedPct)})`);
      lines.push(`Bought ${fmtEth(p.buyEth)} ETH`);
      lines.push(`Sold ${fmtEth(p.sellEth)} ETH`);
      lines.push('');
    }
    return { text: lines.join('\n'), extra: buttons(wallet, window, 'losses') };
  }

  if (view === 'open') {
    lines.push(`📦 <b>Open Positions (>$0.10)</b>`);
    const rows = (data.open || []);
    if (!rows.length) lines.push('<i>No open positions.</i>');
    for (const r of rows) {
      const em = signEmoji(r.unrealizedEth || 0);
      const sym = r.symbol || r.token;
      lines.push(`• ${esc(sym)} — ${em}`);
      lines.push(`Held: ${Number(r.heldNum).toFixed(4)} — Now: ${money(r.usdNow)} (${fmtEth(r.priceNative||0)} ETH/ea)`);
      lines.push(`Unrealized: ${em} ${fmtEth(r.unrealizedEth||0)} ETH`);
      lines.push('');
    }
    return { text: lines.join('\n'), extra: buttons(wallet, window, 'open') };
  }

  if (view === 'airdrops') {
    lines.push(`🎁 <b>Airdrops</b>`);
    const t = data.airdrops?.tokens || [];
    const n = data.airdrops?.nfts   || [];
    if (!t.length && !n.length) lines.push('<i>No airdrops found.</i>');

    if (t.length) {
      lines.push('Tokens:');
      for (const d of t) {
        const sym = d.symbol || d.name || d.ca;
        lines.push(`• ${esc(sym)} — qty ${Number(d.qty).toFixed(4)}`);
      }
      lines.push('');
    }
    if (n.length) {
      lines.push('NFTs:');
      for (const a of n) {
        lines.push(`• ${esc(a.name || a.contract)} — ${a.qty}x`);
      }
      lines.push('');
    }

    return { text: lines.join('\n'), extra: buttons(wallet, window, 'airdrops') };
  }

  // default fallback -> overview
  return { text: lines.join('\n'), extra: buttons(wallet, window, 'overview') };
}
