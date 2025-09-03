// src/renderers_pnl.js
import { esc, money } from './ui_html.js';

const shortAddr = (a) => a ? (a.slice(0,6) + '…' + a.slice(-4)) : '';

/* --- Formatting helpers (Telegram-safe HTML only) --- */
const fmtETH = (x) => (Number(x)||0).toFixed(6) + ' ETH';

function signETH(val){
  const v = Number(val)||0;
  const body = (v>=0?'+':'−') + Math.abs(v).toFixed(6) + ' ETH';
  if (v > 0)  return `🟢 <b>${esc(body)}</b>`;
  if (v < 0)  return `🔴 <b>${esc(body)}</b>`;
  return `⚪️ <b>${esc(body)}</b>`;
}
function pctStr(val){
  const v = Number(val)||0;
  const body = `${v>=0?'+':''}${v.toFixed(2)}%`;
  if (v > 0)  return `🟢 <b>${esc(body)}</b>`;
  if (v < 0)  return `🔴 <b>${esc(body)}</b>`;
  return `⚪️ <b>${esc(body)}</b>`;
}

/* --- Keyboard --- */
function kb(wallet, window, view='overview'){
  const windows = ['24h','7d','30d','90d','all'];
  return {
    inline_keyboard: [
      windows.map(w => ({
        text: w === window ? `· ${w} ·` : w,
        callback_data: `pnlv:${wallet}:${w}:${view}`
      })),
      [
        { text:'🏠 Home',     callback_data:`pnlv:${wallet}:${window}:overview` },
        { text:'🟢 Profits',  callback_data:`pnlv:${wallet}:${window}:profits` },
        { text:'🔴 Losses',   callback_data:`pnlv:${wallet}:${window}:losses` },
      ],
      [
        { text:'📦 Open',     callback_data:`pnlv:${wallet}:${window}:open` },
        { text:'🎁 Airdrops', callback_data:`pnlv:${wallet}:${window}:airdrops` },
        { text:'↻ Refresh',   callback_data:`pnl_refresh:${wallet}:${window}` }
      ]
    ]
  };
}

/* --- Main renderer --- */
export function renderPNL(data, window='30d', view='overview'){
  const w = String(data.wallet||'').toLowerCase();
  const t = data.totals || {};
  const d = data.derived || {};
  const tokens = Array.isArray(data.tokens) ? data.tokens : [];

  if (view === 'profits')  return renderPnLList(w, window, d.best,  true);
  if (view === 'losses')   return renderPnLList(w, window, d.worst, false);
  if (view === 'open')     return renderOpen(w, window, d.open||[]);
  if (view === 'airdrops') return renderAirdrops(w, window, tokens);

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

  const pnl = Number(t.totalPnlBase)||0;
  const badge = pnl>0 ? '🟢' : pnl<0 ? '🔴' : '⚪️';
  lines.push(`${badge} <b>Total PnL:</b> ${(pnl).toFixed(6)} ETH  (${pctStr(t.pnlPct)})`);
  lines.push('');

  // Top 3 winners/losers on overview
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

  return { text: lines.join('\n'), extra: { reply_markup: kb(w, window, 'overview') } };
}

/* --- Profits/Losses pages (closed trades only) --- */
function renderPnLList(wallet, window, rows, isProfit){
  const title = isProfit ? 'Top Profits (realized)' : 'Top Losses (realized)';
  const lines = [];
  lines.push(`<b>${esc(title)}</b>`);
  if (!rows || !rows.length) {
    lines.push('<i>No items</i>');
  } else {
    for (const r of rows){
      const sym  = esc(r.symbol || r.token.slice(0,6));
      const buy  = Number(r.totalBuyBase)||0;
      const sell = Number(r.totalSellBase)||0;
      const pnl  = Number(r.realizedBase)||0;
      const pct  = buy>0 ? (pnl/buy)*100 : 0;
      const leftUnits = r.remaining ? String(r.remaining) : '0';
      const state = (Number(leftUnits)>0) ? 'closed (dust left)' : 'closed';
      lines.push(`• <b>${sym}</b> — ${signETH(pnl)} (${pctStr(pct)})\n   buy ${fmtETH(buy)} · sell ${fmtETH(sell)} · ${esc(state)}`);
    }
  }
  return { text: lines.join('\n'), extra: { reply_markup: kb(wallet, window, isProfit?'profits':'losses') } };
}

/* --- Open positions --- */
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
      lines.push(
        `• <b>${sym}</b>\n` +
        `   rem ≈ ${rem} units · MTM ${signETH(u)} · ${esc(money(usd))}\n` +
        `   buy ${fmtETH(buy)} · sell ${fmtETH(sell)}`
      );
    }
  }
  return { text: lines.join('\n'), extra: { reply_markup: kb(wallet, window, 'open') } };
}

/* --- Airdrops --- */
function renderAirdrops(wallet, window, tokens){
  const rows = (tokens||[]).filter(r => (r.airdrops?.count||0)>0 && Number(r.airdrops?.estUsd||0)>0);
  const lines = [];
  lines.push('<b>Airdrops</b>');
  if (!rows.length){
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