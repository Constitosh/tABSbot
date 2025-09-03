// src/renderers_pnl.js
// Renders: overview (with top3 winners/losers), profits (closed), losses (closed), open, airdrops.

import { esc, money } from './ui_html.js';

const shortAddr = (a) => a ? (a.slice(0,6) + '…' + a.slice(-4)) : '';
const fmtWETH = (w) => `${Number(w).toFixed(6)} ETH`;
const fmtWeiWETH = (wei) => `${(Number(wei)/1e18).toFixed(6)} ETH`;
const badge = (x) => (x > 0 ? '🟢' : (x < 0 ? '🔴' : '⚪️'));

function fmtQty(units, decimals){
  const n = Number(units)/10**decimals;
  if (!isFinite(n) || n === 0) return '0';
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
}

function windowTabs(wallet, currentWindow, view){
  const ws = ['24h','7d','30d','90d','all'];
  return [
    ws.map(w => ({
      text: w === currentWindow ? `· ${w} ·` : w,
      callback_data: `pnlv:${wallet}:${w}:${view}`
    })),
  ];
}

function viewTabs(wallet, window, currentView){
  const views = [
    ['overview','Overview'],
    ['profits','Profits'],
    ['losses','Losses'],
    ['open','Open'],
    ['airdrops','Airdrops']
  ];
  return [
    views.map(([v, label]) => ({
      text: v === currentView ? `· ${label} ·` : label,
      callback_data: `pnlv:${wallet}:${window}:${v}`
    })),
    [
      { text:'↻ Refresh', callback_data:`pnl_refresh:${wallet}:${window}` },
      { text:'🏠 Back',    callback_data:'about' }
    ]
  ];
}

function header(wallet, window, totals){
  const bal = Number(totals.ethLikeBalanceFloat||0);
  const lines = [];
  lines.push(`💼 <b>Wallet PnL — ${shortAddr(esc(wallet))}</b>`);
  lines.push(`<i>Window: ${esc(window)}</i>`);
  lines.push(`💰 <b>Balance:</b> ${bal.toFixed(6)} ETH`);
  lines.push('');
  lines.push(
    [
      `💧 <b>ETH IN:</b> ${esc(fmtWETH((totals.ethInFloat||0) + (totals.wethInFloat||0)))}`,lines.push
      `🔥 <b>ETH OUT:</b> ${esc(fmtWETH((totals.ethOutFloat||0) + (totals.wethOutFloat||0)))}`lines.push
    ].join('   ·   ')
  );
  lines.push(
    [
      `📈 <b>Realized:</b> ${esc(fmtWETH(totals.realizedWeth||0))}`,lines.push
      `📊 <b>Unrealized:</b> ${esc(fmtWETH(totals.unrealizedWeth||0))}`,lines.push
      `📦 <b>Holdings:</b> ${esc(money(totals.holdingsUsd||0))}`,lines.push
      `🎁 <b>Airdrops:</b> ${esc(money(totals.airdropsUsd||0))}`
    ].join('   ·   ')
  );
  const pnl = Number(totals.totalPnlWeth||0);
  const pct = Number(totals.pnlPct||0);
  const pnlTag = `${pnl >= 0 ? '🟢' : '🔴'} ${Math.abs(pnl).toFixed(6)} ETH  (${pct>=0?'+':'−'}${Math.abs(pct).toFixed(2)}%)`;
  lines.push(`🧮 <b>Total PnL:</b> ${pnlTag}`);
  return lines;
}

function lineClosedToken(t){
  const sym = esc(t.symbol || t.token.slice(0,6));
  const realized = Number(t.realizedWeth||0);
  const tag = `${realized>=0?'+':'−'}${Math.abs(realized).toFixed(6)} ETH`;
  // per your ask: remove the dash between token and number
  return `• <b>${sym}</b>  ${badge(realized)} ${tag}`;
}

function top3Section(title, arr){
  const lines = [];
  lines.push(`<b>${title}</b>`);
  if (!arr || !arr.length) {
    lines.push('<i>—</i>');
  } else {
    for (const t of arr) lines.push(lineClosedToken(t));
  }
  return lines;
}

export function renderPNL(data, window='30d', view='overview'){
  const w = esc(data.wallet);
  const t = data.totals || {};
  const d = data.derived || {};
  const tokens = Array.isArray(data.tokens) ? data.tokens : [];

  const lines = [];
  lines.push(...header(w, window, t));
  lines.push('');

  if (view === 'overview') {
    lines.push(...top3Section('Top Profits (closed)', d.top3Profits || []));
    lines.push('');
    lines.push(...top3Section('Top Losses (closed)', d.top3Losses || []));
  }
  else if (view === 'profits') {
    lines.push('<b>Top Profits (closed)</b>');
    const arr = d.profitsClosed || [];
    if (!arr.length) lines.push('<i>No closed profitable trades found.</i>');
    for (const tk of arr.slice(0,15)) lines.push(lineClosedToken(tk));
  }
  else if (view === 'losses') {
    lines.push('<b>Top Losses (closed)</b>');
    const arr = d.lossesClosed || [];
    if (!arr.length) lines.push('<i>No closed losing trades found.</i>');
    for (const tk of arr.slice(0,15)) lines.push(lineClosedToken(tk));
  }
  else if (view === 'open') {
    lines.push('<b>Open Positions</b>');
    const arr = d.open || [];
    if (!arr.length) {
      lines.push('<i>No open positions.</i>');
    } else {
      for (const r of arr) {
        const sym = esc(r.symbol || r.token.slice(0,6));
        const dec = Number(r.decimals||18);
        const rem = fmtQty(r.remaining, dec);
        const unreal = Number(r.unrealizedWeth||0);
        const tag = `${unreal>=0?'+':'−'}${Math.abs(unreal).toFixed(6)} ETH`;
        lines.push(`• <b>${sym}</b>  ${badge(unreal)} ${tag}  ·  rem ${rem}`);
      }
    }
  }
  else if (view === 'airdrops') {
    lines.push('<b>Airdrops</b>');
    const arr = d.airdrops || [];
    if (!arr.length) lines.push('<i>None.</i>');
    for (const a of arr.slice(0,25)) {
      const sym = esc(a.symbol || a.token.slice(0,6));
      lines.push(`• <b>${sym}</b>  ~${esc(money(a.estUsd||0))}`);
    }
  }

  const extra = {
    reply_markup: {
      inline_keyboard: [
        ...windowTabs(w, window, view),
        ...viewTabs(w, window, view)
      ]
    },
    disable_web_page_preview: true
  };

  return { text: lines.join('\n'), extra };
}