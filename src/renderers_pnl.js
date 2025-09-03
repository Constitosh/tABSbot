// src/renderers_pnl.js
import { esc, money } from './ui_html.js';

// helpers
const shortAddr = (a) => a ? (a.slice(0,6) + '…' + a.slice(-4)) : '';
const sign = (x) => (x > 0 ? '+' : (x < 0 ? '−' : '±'));
const fmtWETH = (w) => `${Number(w).toFixed(6)} ETH`;         // display in ETH units
const fmtWeiWETH = (wei) => `${(Number(wei)/1e18).toFixed(6)} ETH`;
const fmtETH = (e) => `${Number(e).toFixed(6)} ETH`;
const green = (s) => s; // Telegram doesn’t support colored fonts; keep plain, use emojis
const red   = (s) => s;

function fmtQty(units, decimals){
  const n = Number(units)/10**decimals;
  if (n === 0) return '0';
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
}

function isEthLike(symbol, token) {
  const up = String(symbol || '').toUpperCase();
  return up === 'ETH' || up === 'WETH' || String(token||'').toLowerCase() === '0x3439153eb7af838ad19d56e1571fbd09333c2809';
}

function headerChips(wallet, currentWindow, currentView){
  const windows = ['24h','7d','30d','90d','all'];
  const views   = [
    { key:'overview', label:'🏠 Overview' },
    { key:'profits',  label:'🟢 Profits' },
    { key:'losses',   label:'🔴 Losses' },
    { key:'open',     label:'📦 Open' },
    { key:'airdrops', label:'🎁 Airdrops' },
  ];
  return {
    inline_keyboard: [
      windows.map(w => ({
        text: w === currentWindow ? `· ${w} ·` : w,
        callback_data: `pnlv:${wallet}:${w}:${currentView}`
      })),
      views.map(v => ({
        text: v.key === currentView ? `· ${v.label} ·` : v.label,
        callback_data: `pnlv:${wallet}:${currentWindow}:${v.key}`
      })),
      [
        { text:'↻ Refresh', callback_data:`pnl_refresh:${wallet}:${currentWindow}` },
        { text:'Back',      callback_data:'about' }
      ]
    ]
  };
}

// build closed-only realized lists (remaining < 5 tokens except ETH/WETH)
function pickClosedRealized(tokens) {
  const out = [];
  for (const r of tokens) {
    const dec = Number(r.decimals||18);
    const remainingUnits = BigInt(String(r.remaining || '0'));
    const minUnits = 5n * (10n ** BigInt(dec));
    const symUp = String(r.symbol||'').toUpperCase();
    const ethish = isEthLike(symUp, r.token);
    const closed = ethish ? (remainingUnits === 0n) : (remainingUnits === 0n || remainingUnits < minUnits);
    const realized = Number(r.realizedWeth || 0);
    if (closed && realized !== 0) {
      out.push({
        ...r,
        realized
      });
    }
  }
  return out;
}

function renderTopList(list, title, emptyTxt='No items') {
  const lines = [];
  lines.push(`<b>${esc(title)}</b>`);
  if (!list.length) {
    lines.push(`<i>${esc(emptyTxt)}</i>`);
    return lines.join('\n');
  }
  for (const r of list) {
    const realized = Number(r.realizedWeth || 0);
    const sym = esc(r.symbol || r.token.slice(0,6));
    const tag = (realized >= 0)
      ? `🟢 ${fmtETH(realized)}`
      : `🔴 ${fmtETH(Math.abs(realized))}`;
    lines.push(`• <b>${sym}</b> ${tag}`);
  }
  return lines.join('\n');
}

function renderOpenPositions(tokens) {
  const lines = [];
  lines.push('<b>Open Positions</b>');
  const open = tokens.filter(t => Number(t.remaining) > 0);
  if (!open.length) {
    lines.push('<i>No open positions.</i>');
    return lines.join('\n');
  }
  for (const r of open) {
    const dec = Number(r.decimals||18);
    const sym = esc(r.symbol || r.token.slice(0,6));
    const rem = fmtQty(r.remaining, dec);
    const unreal = Number(r.unrealizedWeth || 0);
    const tag = (unreal >= 0)
      ? `🟢 ${fmtETH(unreal)}`
      : `🔴 ${fmtETH(Math.abs(unreal))}`;
    lines.push(`• <b>${sym}</b> — rem ${rem}, unreal ${tag}`);
  }
  return lines.join('\n');
}

function renderAirdrops(tokens) {
  const lines = [];
  lines.push('<b>Airdrops</b>');
  const drops = tokens
    .map(t => ({ sym: t.symbol || t.token.slice(0,6), ...t.airdrops, priceUsd: t.priceUsd }))
    .filter(a => (a?.count || 0) > 0);

  if (!drops.length) {
    lines.push('<i>No airdrops.</i>');
    return lines.join('\n');
  }
  for (const d of drops) {
    const usd = Number(d.estUsd || 0);
    lines.push(`• <b>${esc(d.sym)}</b> — ${esc(money(usd))}`);
  }
  return lines.join('\n');
}

export function renderPNL(data, window='30d', view='overview'){
  const w = esc(data.wallet);
  const t = data.totals || {};
  const tokens = Array.isArray(data.tokens) ? data.tokens : [];

  // Pre-compute the closed-only realized lists for overview + dedicated views
  const realizedClosed = pickClosedRealized(tokens);
  const topProfits = [...realizedClosed].sort((a,b)=> (Number(b.realizedWeth)||0) - (Number(a.realizedWeth)||0)).slice(0,15);
  const topLosses  = [...realizedClosed].sort((a,b)=> (Number(a.realizedWeth)||0) - (Number(b.realizedWeth)||0)).slice(0,15);

  // Header
  const lines = [];
  lines.push(`💼 <b>Wallet PnL — ${shortAddr(w)}</b>`);
  lines.push(`<i>Window: ${esc(window)}</i>`);
  // ETH balance line (native ETH)
  const ethBal = Number(t.ethBalanceFloat || 0);
  lines.push(`💰 <b>Wallet Balance:</b> ${fmtETH(ethBal)}`);
  lines.push('');

  // Flows + buckets: each on its own line (as requested)
  lines.push(`💧 <b>ETH IN:</b>  ${fmtETH(t.ethInFloat || 0)}   ·   🔷 <b>WETH IN:</b> ${fmtETH(t.wethInFloat || 0)}`);
  lines.push(`🔥 <b>ETH OUT:</b> ${fmtETH(t.ethOutFloat || 0)}   ·   🔶 <b>WETH OUT:</b> ${fmtETH(t.wethOutFloat || 0)}`);
  lines.push(`📈 <b>Realized:</b> ${fmtETH(t.realizedWeth || 0)}`);
  lines.push(`📊 <b>Unrealized:</b> ${fmtETH(t.unrealizedWeth || 0)}`);
  lines.push(`📦 <b>Holdings:</b> ${esc(money(t.holdingsUsd || 0))}   ·   🎁 <b>Airdrops:</b> ${esc(money(t.airdropsUsd || 0))}`);

  // Total PnL (in ETH) + %
  const totalPnl = Number(t.totalPnlWeth || 0);
  const pnlPct   = Number(t.pnlPct || 0);
  const pnlBadge = totalPnl > 0 ? '🟢' : (totalPnl < 0 ? '🔴' : '⚪️');
  const pnlText  = `${pnlBadge} <b>Total PnL:</b> ${fmtETH(Math.abs(totalPnl))}  (${sign(pnlPct)}${Math.abs(pnlPct).toFixed(2)}%)`;
  lines.push(pnlText);
  lines.push('');

  // View content
  if (view === 'profits') {
    lines.push(renderTopList(topProfits, 'Top Profits (realized)', 'No realized profitable trades.'));
  } else if (view === 'losses') {
    lines.push(renderTopList(topLosses,  'Top Losses (realized)',  'No realized losing trades.'));
  } else if (view === 'open') {
    lines.push(renderOpenPositions(tokens));
  } else if (view === 'airdrops') {
    lines.push(renderAirdrops(tokens));
  } else {
    // Overview: show top 3 profits & top 3 losses (closed-only)
    lines.push(renderTopList(topProfits.slice(0,3), 'Top Profits (realized)'));
    lines.push('');
    lines.push(renderTopList(topLosses.slice(0,3), 'Top Losses (realized)'));
  }

  const extra = {
    reply_markup: headerChips(w, window, view)
  };

  return { text: lines.join('\n'), extra };
}