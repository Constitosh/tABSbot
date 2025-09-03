// src/renderers_pnl.js
import { esc, money } from './ui_html.js';

const shortAddr = (a) => a ? (a.slice(0,6) + '…' + a.slice(-4)) : '';
const sign = (x) => (x > 0 ? '+' : (x < 0 ? '−' : '±'));
const fmtWETH = (w) => `${Number(w).toFixed(6)} WETH`;
const fmtWeiWETH = (wei) => `${(Number(wei)/1e18).toFixed(6)} WETH`;
const fmtETH = (e) => `${Number(e).toFixed(6)} ETH`;
const pct = (x) => `${(Number(x)||0).toFixed(2)}%`;

function fmtQty(units, decimals){
  const n = Number(units)/10**Number(decimals||18);
  if (!isFinite(n)) return '0';
  if (n === 0) return '0';
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
}

function headerChips(wallet, currentWindow, currentView){
  const windows = ['24h','7d','30d','365d','all'];
  const views = [
    { key:'overview',      label:'Overview' },
    { key:'profits',       label:'Top Profits' },
    { key:'losses',        label:'Top Losses' },
    { key:'open',          label:'Open Positions' },
    { key:'airdrops',      label:'Airdrops' }
  ];
  return [
    windows.map(w => ({
      text: w === currentWindow ? `· ${w} ·` : w,
      callback_data: `pnlv:${wallet}:${w}:${currentView}`
    })),
    views.map(v => ({
      text: v.key===currentView ? `· ${v.label} ·` : v.label,
      callback_data: `pnlv:${wallet}:${currentWindow}:${v.key}`
    })),
    [
      { text:'↻ Refresh', callback_data:`pnl_refresh:${wallet}:${currentWindow}` },
      { text:'🏠 Back',    callback_data:'about' }
    ]
  ];
}

function badge(x){
  const n = Number(x||0);
  if (n > 0) return '🟢';
  if (n < 0) return '🔴';
  return '⚪️';
}

function lineForToken(t){
  const sym = esc(t.symbol || t.token.slice(0,6));
  const dec = Number(t.decimals||18);
  const buys  = fmtQty(t.buys, dec);
  const sells = fmtQty(t.sells, dec);
  const rem   = fmtQty(t.remaining, dec);
  const realized = Number(t.realizedWeth||0);
  const unreal   = Number(t.unrealizedWeth||0);
  const total    = realized + unreal;
  const tag = `${badge(total)} ${sign(total)}${Math.abs(total).toFixed(6)} WETH`;
  const remUsd = Number(t.usdValueRemaining||0);

  return `• <b>${sym}</b> — ${tag}\n` +
         `   buy ${buys}, sell ${sells}, rem ${rem}  ·  💵 ${esc(money(remUsd))}\n` +
         `   real ${esc(fmtWETH(realized))}, unreal ${esc(fmtWETH(unreal))}`;
}

export function renderPNL(data, window='30d', view='overview'){
  const w = esc(data.wallet);
  const t = data.totals || {};
  const derived = data.derived || {};

  const lines = [];
  lines.push(`💼 <b>Wallet PnL — ${shortAddr(w)}</b>`);
  lines.push(`<i>Window: ${esc(window)}</i>`);
  lines.push('');

  // Totals / header cards
  lines.push(
    [
      `💧 <b>WETH IN:</b> ${esc(fmtWeiWETH(t.wethIn||'0'))}`,
      `🔥 <b>WETH OUT:</b> ${esc(fmtWeiWETH(t.wethOut||'0'))}`,
      `🪙 <b>ETH IN:</b> ${esc(fmtETH(t.ethInFloat||0))}`,
      `🚀 <b>ETH OUT:</b> ${esc(fmtETH(t.ethOutFloat||0))}`
    ].join('   ·   ')
  );
  lines.push(
    [
      `📈 <b>Realized:</b> ${esc(fmtWETH(t.realizedWeth||0))}`,
      `📉 <b>Unrealized:</b> ${esc(fmtWETH(t.unrealizedWeth||0))}`,
      `📊 <b>PnL%:</b> ${esc(pct(t.pnlPct||0))}`
    ].join('   ·   ')
  );
  lines.push(
    [
      `💼 <b>Holdings (USD):</b> ${esc(money(t.holdingsUsd||0))}`,
      `🎁 <b>Airdrops (USD):</b> ${esc(money(t.airdropsUsd||0))}`
    ].join('   ·   ')
  );
  lines.push('');

  if (view === 'overview') {
    const best = Array.isArray(derived.best) ? derived.best.slice(0,3) : [];
    const worst = Array.isArray(derived.worst) ? derived.worst.slice(0,3) : [];

    lines.push('<b>Best trades (top 3)</b>');
    if (!best.length) lines.push('<i>— none —</i>');
    else best.forEach(t => lines.push(lineForToken(t)));

    lines.push('');
    lines.push('<b>Worst trades (top 3)</b>');
    if (!worst.length) lines.push('<i>— none —</i>');
    else worst.forEach(t => lines.push(lineForToken(t)));
  }

  if (view === 'profits') {
    const list = Array.isArray(derived.best) ? derived.best : [];
    lines.push('<b>Top 15 Profits</b>');
    if (!list.length) lines.push('<i>— none —</i>');
    else list.forEach(t => lines.push(lineForToken(t)));
  }

  if (view === 'losses') {
    const list = Array.isArray(derived.worst) ? derived.worst : [];
    lines.push('<b>Top 15 Losses</b>');
    if (!list.length) lines.push('<i>— none —</i>');
    else list.forEach(t => lines.push(lineForToken(t)));
  }

  if (view === 'open') {
    const list = Array.isArray(derived.open) ? derived.open : [];
    lines.push('<b>Open Positions</b>');
    if (!list.length) lines.push('<i>— none —</i>');
    else list.forEach(t => lines.push(lineForToken(t)));
  }

  if (view === 'airdrops') {
    const list = Array.isArray(derived.airdrops) ? derived.airdrops : [];
    lines.push('<b>Airdrops</b>');
    if (!list.length) lines.push('<i>— none —</i>');
    else {
      for (const a of list) {
        const qty = fmtQty(a.units, a.decimals);
        lines.push(`• <b>${esc(a.symbol || a.token.slice(0,6))}</b> — ${esc(qty)}   (est. ${esc(money(a.estUsd||0))})`);
      }
    }
  }

  const extra = {
    reply_markup: {
      inline_keyboard: headerChips(w, window, view)
    }
  };

  return { text: lines.join('\n'), extra };
}
