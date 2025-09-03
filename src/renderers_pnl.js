// src/renderers_pnl.js
import { esc, money } from './ui_html.js';

// helpers
const shortAddr = (a) => a ? (a.slice(0,6) + '…' + a.slice(-4)) : '';
const sign = (x) => (x > 0 ? '+' : (x < 0 ? '−' : '±'));
const fmtETH = (w) => `${Number(w).toFixed(6)} ETH`;
const fmtWeiETH = (wei) => `${(Number(wei)/1e18).toFixed(6)} ETH`;
const greenBadge = '🟢';
const redBadge   = '🔴';
const flatBadge  = '⚪️';

function qtyFmtFloat(n){
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
}

function headerChips(wallet, currentWindow, currentView){
  const windows = ['24h','7d','30d','90d','all']; // 90d window
  return {
    inline_keyboard: [
      windows.map(w => ({
        text: w === currentWindow ? `· ${w} ·` : w,
        callback_data: `pnlview:${wallet}:${w}:${currentView}`
      })),
      [
        { text:'🏆 Profits', callback_data:`pnlview:${wallet}:${currentWindow}:profits` },
        { text:'⚠️ Losses',  callback_data:`pnlview:${wallet}:${currentWindow}:losses` },
      ],
      [
        { text:'📈 Open',    callback_data:`pnlview:${wallet}:${currentWindow}:open` },
        { text:'🎁 Airdrops',callback_data:`pnlview:${wallet}:${currentWindow}:airdrops` }
      ],
      [
        { text:'↻ Refresh',  callback_data:`pnl_refresh:${wallet}:${currentWindow}` },
        { text:'🏠 Back',     callback_data:'about' }
      ]
    ]
  };
}

function pnlBadge(num){
  if (num > 0) return greenBadge;
  if (num < 0) return redBadge;
  return flatBadge;
}

function bulletPnL(symbol, ethAmount){
  const s = Number(ethAmount||0);
  const tag = `${s === 0 ? '0.000000' : (s > 0 ? '+' : '−') + Math.abs(s).toFixed(6)} ETH`;
  // No dash between token and amount, as requested
  return `• <b>${esc(symbol)}</b>  ${pnlBadge(s)} ${esc(tag)}`;
}

// Renders a compact list (up to n) from tokens array with realizedWeth field
function renderClosedRealizedList(rows, n=15){
  if (!Array.isArray(rows) || rows.length === 0) return '<i>None</i>';
  const slice = rows.slice(0, n);
  return slice.map(r => bulletPnL(r.symbol || r.token.slice(0,6), r.realizedWeth)).join('\n');
}

export function renderPNL(data, window='30d', view='overview'){
  const w = esc(data.wallet);
  const t = data.totals || {};
  const derived = data.derived || {};
  const tokens = Array.isArray(data.tokens) ? data.tokens : [];

  const lines = [];
  lines.push(`💼 <b>Wallet PnL — ${shortAddr(w)}</b>`);
  lines.push(`<i>Window: ${esc(window)}</i>`);

  // NEW: ETH balance line (native ETH)
  lines.push(`💰 <b>ETH Balance:</b> ${esc(fmtETH(t.ethBalanceFloat || 0))}`);
  lines.push(''); // keep spacing exactly like your sample

  // Totals “cards” — ETH+WETH flows shown as ETH (label ETH)
  const ethIn  = (Number(t.ethInFloat||0) + Number(t.wethInFloat||0));
  const ethOut = (Number(t.ethOutFloat||0) + Number(t.wethOutFloat||0));
  lines.push(
    [
      `💧 <b>ETH IN:</b> ${esc(fmtETH(ethIn))}`,
      `🔥 <b>ETH OUT:</b> ${esc(fmtETH(ethOut))}`
    ].join('   ·   ')
  );
  lines.push(
    [
      `📈 <b>Realized:</b> ${esc(fmtETH(t.realizedWeth||0))}`,
      `📊 <b>Unrealized:</b> ${esc(fmtETH(t.unrealizedWeth||0))}`,
      `📦 <b>Holdings:</b> ${esc(money(t.holdingsUsd||0))}`,
      `🎁 <b>Airdrops:</b> ${esc(money(t.airdropsUsd||0))}`
    ].join('   ·   ')
  );

  const totalPnl = Number(t.totalPnlWeth||0);
  const pct = Number(t.pnlPct||0);
  const pnlLine = `${pnlBadge(totalPnl)} <b>Total PnL:</b> ${esc(fmtETH(totalPnl))}  (${sign(pct)}${Math.abs(pct).toFixed(2)}%)`;
  lines.push(pnlLine);
  lines.push('');

  if (view === 'overview') {
    // Top 3 realized profits & losses (CLOSED positions only)
    lines.push('<b>Top Profits (realized)</b>');
    lines.push(renderClosedRealizedList(derived.profitsClosed, 3));
    lines.push('');
    lines.push('<b>Top Losses (realized)</b>');
    lines.push(renderClosedRealizedList(derived.lossesClosed, 3));
  }
  else if (view === 'profits') {
    lines.push('<b>Top Profits (realized)</b>');
    lines.push(renderClosedRealizedList(derived.profitsClosed, 15));
  }
  else if (view === 'losses') {
    lines.push('<b>Top Losses (realized)</b>');
    lines.push(renderClosedRealizedList(derived.lossesClosed, 15));
  }
  else if (view === 'open') {
    lines.push('<b>Open Positions</b>');
    const rows = Array.isArray(derived.open) ? derived.open : [];
    if (!rows.length) {
      lines.push('<i>None</i>');
    } else {
      // Show symbol, remaining qty, and USD value; PnL marker with unrealized
      for (const r of rows) {
        const sym = esc(r.symbol || r.token.slice(0,6));
        const rem = qtyFmtFloat(Number(r.remainingUnitsFloat || 0));
        const usd = Number(r.usdValueRemaining || 0);
        const unreal = Number(r.unrealizedWeth || 0);
        lines.push(`• <b>${sym}</b>  ${pnlBadge(unreal)} ${esc(sign(unreal))}${Math.abs(unreal).toFixed(6)} ETH`);
        lines.push(`   rem ${rem}   ·   worth ${esc(money(usd))}`);
      }
    }
  }
  else if (view === 'airdrops') {
    lines.push('<b>Airdrops</b>');
    const rows = Array.isArray(derived.airdrops) ? derived.airdrops : [];
    if (!rows.length) {
      lines.push('<i>None</i>');
    } else {
      for (const r of rows) {
        const sym = esc(r.symbol || r.token.slice(0,6));
        const est = Number(r.estUsd || 0);
        lines.push(`• <b>${sym}</b>  ≈ ${esc(money(est))}`);
      }
    }
  }

  const extra = { reply_markup: headerChips(w, window, view) };
  return { text: lines.join('\n'), extra };
}
