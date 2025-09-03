// src/renderers_pnl.js
// Renders: overview (with top3 winners/losers), profits (closed), losses (closed), open, airdrops.

import { esc, money } from './ui_html.js';

const shortAddr = (a) => a ? (a.slice(0,6) + '…' + a.slice(-4)) : '';
const fmtETH = (w) => `${Number(w).toFixed(6)} ETH`;
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

  const ethIn  = (Number(totals.ethInFloat||0)  + Number(totals.wethInFloat||0));
  const ethOut = (Number(totals.ethOutFloat||0) + Number(totals.wethOutFloat||0));

  const realized   = Number(totals.realizedWeth||0);
  const unrealized = Number(totals.unrealizedWeth||0);
  const holdings   = Number(totals.holdingsUsd||0);
  const airdrops   = Number(totals.airdropsUsd||0);

  const pnl = Number(totals.totalPnlWeth||0);
  const pct = Number(totals.pnlPct||0);
  const pnlTag = `${pnl >= 0 ? '🟢' : '🔴'} ${Math.abs(pnl).toFixed(6)} ETH  (${pct>=0?'+':'−'}${Math.abs(pct).toFixed(2)}%)`;

  const lines = [];
  lines.push(`💼 <b>Wallet PnL — ${shortAddr(esc(wallet))}</b>`);
  lines.push(`<i>Window: ${esc(window)}</i>`);
  lines.push(`💰 <b>Balance:</b> ${bal.toFixed(6)} ETH`);
  lines.push('');
  // one metric per line (requested)
  lines.push(`💧 <b>ETH IN:</b> ${esc(fmtETH(ethIn))}`);
  lines.push(`🔥 <b>ETH OUT:</b> ${esc(fmtETH(ethOut))}`);
  lines.push(`📈 <b>Realized:</b> ${esc(fmtETH(realized))}`);
  lines.push(`📊 <b>Unrealized:</b> ${esc(fmtETH(unrealized))}`);
  lines.push(`📦 <b>Holdings:</b> ${esc(money(holdings))}`);
  lines.push(`🎁 <b>Airdrops:</b> ${esc(money(airdrops))}`);
  lines.push(`🧮 <b>Total PnL:</b> ${pnlTag}`);
  return lines;
}

function lineClosedToken(t){
  const sym = esc(t.symbol || t.token.slice(0,6));
  const realized = Number(t.realizedWeth||0);
  const tag = `${realized>=0?'+':'−'}${Math.abs(realized).toFixed(6)} ETH`;
  // no dash between token and number
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

function ensureTop3FromTokens(tokens){
  // Fallback top3 computation if derived not present or empty
  // Closed = remaining == 0 or isDust; realized > 0 for profits, < 0 for losses.
  const closed = (tokens||[]).filter(t => {
    const rem = Number(t.remaining || 0) / (10 ** Number(t.decimals||18));
    return rem === 0 || !!t.isDust;
  });
  const profits = closed.filter(t => Number(t.realizedWeth||0) > 0)
    .sort((a,b)=> Number(b.realizedWeth)-Number(a.realizedWeth))
    .slice(0,3);
  const losses = closed.filter(t => Number(t.realizedWeth||0) < 0)
    .sort((a,b)=> Number(a.realizedWeth)-Number(b.realizedWeth))
    .slice(0,3);
  return { profits, losses };
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
    const top3P = Array.isArray(d.top3Profits) && d.top3Profits.length ? d.top3Profits : null;
    const top3L = Array.isArray(d.top3Losses)  && d.top3Losses.length  ? d.top3Losses  : null;
    const fallback = (!top3P || !top3L) ? ensureTop3FromTokens(tokens) : null;

    lines.push(...top3Section('Top Profits (closed)', top3P || fallback.profits));
    lines.push('');
    lines.push(...top3Section('Top Losses (closed)', top3L || fallback.losses));
  }
  else if (view === 'profits') {
    lines.push('<b>Top Profits (closed)</b>');
    const arr = Array.isArray(d.profitsClosed) ? d.profitsClosed : [];
    if (!arr.length) lines.push('<i>No closed profitable trades found.</i>');
    for (const tk of arr.slice(0,15)) lines.push(lineClosedToken(tk));
  }
  else if (view === 'losses') {
    lines.push('<b>Top Losses (closed)</b>');
    const arr = Array.isArray(d.lossesClosed) ? d.lossesClosed : [];
    if (!arr.length) lines.push('<i>No closed losing trades found.</i>');
    for (const tk of arr.slice(0,15)) lines.push(lineClosedToken(tk));
  }
  else if (view === 'open') {
    lines.push('<b>Open Positions</b>');
    const arr = Array.isArray(d.open) ? d.open : [];
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
    const arr = Array.isArray(d.airdrops) ? d.airdrops : [];
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