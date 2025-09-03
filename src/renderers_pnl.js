// src/renderers_pnl.js
import { esc, money } from './ui_html.js';

const shortAddr = (a) => a ? (a.slice(0,6) + '…' + a.slice(-4)) : '';
const fmtETH = (x) => (Number(x)||0).toFixed(6) + ' ETH';
const green = (s) => `<b><span style="color:#2ecc71">${esc(s)}</span></b>`;
const red   = (s) => `<b><span style="color:#e74c3c">${esc(s)}</span></b>`;
const gray  = (s) => `<b><span style="color:#95a5a6">${esc(s)}</span></b>`;

// window/view keyboard
function kb(wallet, window, view='overview'){
  const windows = ['24h','7d','30d','90d','all'];
  return {
    inline_keyboard: [
      windows.map(w => ({
        text: w === window ? `· ${w} ·` : w,
        callback_data: `pnlv:${wallet}:${w}:${view}`
      })),
      [
        { text:'🏠 Home', callback_data:`pnlv:${wallet}:${window}:overview` },
        { text:'🟢 Profits', callback_data:`pnlv:${wallet}:${window}:profits` },
        { text:'🔴 Losses',  callback_data:`pnlv:${wallet}:${window}:losses` },
      ],
      [
        { text:'📦 Open',   callback_data:`pnlv:${wallet}:${window}:open` },
        { text:'🎁 Airdrops', callback_data:`pnlv:${wallet}:${window}:airdrops` },
        { text:'↻ Refresh',  callback_data:`pnl_refresh:${wallet}:${window}` }
      ]
    ]
  };
}

function pctStr(x){
  const v = Number(x)||0;
  const s = `${v>=0?'+':''}${v.toFixed(2)}%`;
  return v>0 ? green(s) : v<0 ? red(s) : gray(s);
}
function signETH(x){
  const v = Number(x)||0;
  const s = (v>=0?'+':'−') + Math.abs(v).toFixed(6) + ' ETH';
  return v>0 ? green(s) : v<0 ? red(s) : gray(s);
}

// -------- Overview --------
export function renderPNL(data, window='30d', view='overview'){
  const w = String(data.wallet||'').toLowerCase();
  const t = data.totals || {};
  const d = data.derived || {};
  const tokens = Array.isArray(data.tokens) ? data.tokens : [];

  const lines = [];
  lines.push(`💼 <b>Wallet PnL — ${esc(shortAddr(w))}</b>`);
  lines.push(`<i>Window: ${esc(window)}</i>`);
  lines.push(`💰 <b>Wallet Balance:</b> ${esc((Number(t.ethBalance)||0).toFixed(6))} ETH`);
  lines.push('');

  // unified base (ETH+WETH) only
  lines.push(`💧 <b>ETH IN:</b> ${esc((Number(t.baseIn)||0).toFixed(6))} ETH`);
  lines.push(`🔥 <b>ETH OUT:</b> ${esc((Number(t.baseOut)||0).toFixed(6))} ETH`);
  lines.push(`📈 <b>Realized:</b> ${esc((Number(t.realizedBase)||0).toFixed(6))} ETH`);
  lines.push(`📊 <b>Unrealized:</b> ${esc((Number(t.unrealizedBase)||0).toFixed(6))} ETH`);
  lines.push(`📦 <b>Holdings:</b> ${esc(money(Number(t.holdingsUsd)||0))}`);
  lines.push(`🎁 <b>Airdrops:</b> ${esc(money(Number(t.airdropsUsd)||0))}`);

  const totalP = Number(t.totalPnlBase)||0;
  const pnlLine = `${totalP>0?'🟢':totalP<0?'🔴':'⚪️'} <b>Total PnL:</b> ${(totalP).toFixed(6)} ETH  (${pctStr(t.pnlPct)})`;
  lines.push(pnlLine);
  lines.push('');

  // show top 3 winners/losers on overview
  const best = Array.isArray(d.best) ? d.best.slice(0,3) : [];
  const worst = Array.isArray(d.worst) ? d.worst.slice(0,3) : [];

  lines.push('<b>Top Profits (realized)</b>');
  if (!best.length) {
    lines.push('<i>No items</i>');
  } else {
    for (const r of best){
      const sym = esc(r.symbol || r.token.slice(0,6));
      lines.push(`• ${sym} ${signETH(r.realizedBase)}`);
    }
  }
  lines.push('');
  lines.push('<b>Top Losses (realized)</b>');
  if (!worst.length) {
    lines.push('<i>No items</i>');
  } else {
    for (const r of worst){
      const sym = esc(r.symbol || r.token.slice(0,6));
      lines.push(`• ${sym} ${signETH(r.realizedBase)}`);
    }
  }

  // route extra views
  if (view === 'profits') {
    return renderPnLList(w, window, d.best, 'Top Profits (realized)');
  }
  if (view === 'losses') {
    return renderPnLList(w, window, d.worst, 'Top Losses (realized)');
  }
  if (view === 'open') {
    const open = Array.isArray(d.open) ? d.open : [];
    return renderOpen(w, window, open);
  }
  if (view === 'airdrops') {
    const airdrops = tokens.filter(r => (r.airdrops?.count||0)>0 && Number(r.airdrops?.estUsd||0)>0);
    return renderAirdrops(w, window, airdrops);
  }

  return { text: lines.join('\n'), extra: { reply_markup: kb(w, window, 'overview') } };
}

// -------- Profits/Losses list (closed trades only) --------
function renderPnLList(wallet, window, rows, title){
  const lines = [];
  lines.push(`<b>${esc(title)}</b>`);
  if (!rows || !rows.length) {
    lines.push('<i>No items</i>');
  } else {
    for (const r of rows){
      const sym = esc(r.symbol || r.token.slice(0,6));
      const buy = Number(r.totalBuyBase)||0;
      const sell= Number(r.totalSellBase)||0;
      const pnl = Number(r.realizedBase)||0;
      const pct = buy>0 ? (pnl/buy)*100 : 0;
      const left = Number(r.remaining||'0');
      const det = `buy ${buy.toFixed(6)} · sell ${sell.toFixed(6)} · ${left<1?'closed':'dust'}`;
      lines.push(`• <b>${sym}</b> — ${signETH(pnl)}  (${pctStr(pct)})\n   ${esc(det)}`);
    }
  }
  return { text: lines.join('\n'), extra: { reply_markup: kb(wallet, window, title.toLowerCase().includes('profit') ? 'profits' : 'losses') } };
}

// -------- Open positions (hide <5 tokens, except ETH/WETH already filtered in the worker) --------
function renderOpen(wallet, window, rows){
  const lines = [];
  lines.push('<b>Open Positions</b>');
  if (!rows || !rows.length){
    lines.push('<i>No open positions</i>');
  } else {
    for (const r of rows){
      const sym = esc(r.symbol || r.token.slice(0,6));
      const rem = Number(r.remaining||'0');
      const buy = Number(r.totalBuyBase)||0;
      const sell= Number(r.totalSellBase)||0;
      const u   = Number(r.unrealizedBase)||0;
      const usd = Number(r.usdValueRemaining)||0;
      const det = `rem ≈ ${rem} units · mtm ${signETH(u)} · ${esc(money(usd))}`;
      lines.push(`• <b>${sym}</b>\n   ${esc(det)}\n   buy ${buy.toFixed(6)} · sell ${sell.toFixed(6)}`);
    }
  }
  return { text: lines.join('\n'), extra: { reply_markup: kb(wallet, window, 'open') } };
}

// -------- Airdrops --------
function renderAirdrops(wallet, window, rows){
  const lines = [];
  lines.push('<b>Airdrops</b>');
  if (!rows || !rows.length){
    lines.push('<i>No airdrops</i>');
  } else {
    for (const r of rows){
      const sym = esc(r.symbol || r.token.slice(0,6));
      const est = Number(r.airdrops?.estUsd||0);
      lines.push(`• <b>${sym}</b> — ${esc(money(est))}`);
    }
  }
  return { text: lines.join('\n'), extra: { reply_markup: kb(wallet, window, 'airdrops') } };
}