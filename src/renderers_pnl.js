// src/renderers_pnl.js
import { esc, money } from './ui_html.js';

// helpers
const shortAddr = (a) => a ? (a.slice(0,6) + '…' + a.slice(-4)) : '';
const sign = (x) => (x > 0 ? '+' : (x < 0 ? '−' : '±'));
const fmtWETH = (w) => `${Number(w).toFixed(6)} WETH`;
const fmtWeiWETH = (wei) => `${(Number(wei)/1e18).toFixed(6)} WETH`;
const badge = (x) => {
  const s = Number(x);
  if (s > 0)  return '🟢';
  if (s < 0)  return '🔴';
  return '⚪️';
};

function fmtQty(units, decimals){
  const n = Number(units)/10**decimals;
  if (n === 0) return '0';
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(4);
}

function headerChips(wallet, currentWindow){
  const windows = ['24h','7d','30d','365d','all'];
  return [
    windows.map(w => ({
      text: w === currentWindow ? `· ${w} ·` : w,
      callback_data: `pnl:${wallet}:${w}`
    })),
    [
      { text:'↻ Refresh', callback_data:`pnl_refresh:${wallet}:${currentWindow}` },
      { text:'🏠 Back',    callback_data:'about' }
    ]
  ];
}

export function renderPNL(data, window='30d'){
  const w = esc(data.wallet);
  const t = data.totals || {};
  const tokens = Array.isArray(data.tokens) ? data.tokens : [];

  // Top section
  const lines = [];
  lines.push(`💼 <b>Wallet PnL — ${shortAddr(w)}</b>`);
  lines.push(`<i>Window: ${esc(window)}</i>`);
  lines.push('');

  // Totals “cards”
  lines.push(
    [
      `💧 <b>WETH IN:</b> ${esc(fmtWeiWETH(t.wethIn||'0'))}`,
      `🔥 <b>WETH OUT:</b> ${esc(fmtWeiWETH(t.wethOut||'0'))}`
    ].join('   ·   ')
  );
  lines.push(
    [
      `📈 <b>Realized:</b> ${esc(fmtWETH(t.realizedWeth||0))}`,
      `📊 <b>Unrealized:</b> ${esc(fmtWETH(t.unrealizedWeth||0))}`,
      `🎁 <b>Airdrops:</b> ${esc(money(t.airdropsUsd||0))}`
    ].join('   ·   ')
  );

  lines.push('');
  lines.push('<b>Top 15 tokens</b> <i>(by |real|+|unreal|)</i>');

  // Sort by absolute total P/L impact
  const ranked = tokens
    // Hide native WETH/ETH “token” row if it sneaks in
    .filter(r => (r.symbol||'').toUpperCase() !== 'WETH' && (r.symbol||'').toUpperCase() !== 'ETH')
    .map(r => {
      const realized = Number(r.realizedWeth||0)/1; // already WETH float in your data
      const unreal   = Number(r.unrealizedWeth||0);
      const score    = Math.abs(realized) + Math.abs(unreal);
      return { r, realized, unreal, score };
    })
    .sort((a,b)=> b.score - a.score)
    .slice(0,15);

  if (!ranked.length) {
    lines.push('<i>No token trades found in this window.</i>');
  } else {
    for (const { r, realized, unreal } of ranked) {
      const sym = esc(r.symbol || r.token.slice(0,6));
      const dec = Number(r.decimals||18);
      const buys  = fmtQty(r.buys, dec);
      const sells = fmtQty(r.sells, dec);
      const rem   = fmtQty(r.remaining, dec);
      const total = realized + unreal;

      const tag = badge(total) + ' ' + (total === 0 ? '0.000000' : (total > 0 ? '+' : '−') + Math.abs(total).toFixed(6)) + ' WETH';

      lines.push(
        `• <b>${sym}</b> — ${tag}\n` +
        `   buy ${buys}, sell ${sells}, rem ${rem}\n` +
        `   real ${esc(fmtWETH(realized))}, unreal ${esc(fmtWETH(unreal))}`
      );
    }
  }

  const extra = {
    reply_markup: {
      inline_keyboard: headerChips(w, window)
    }
  };

  return { text: lines.join('\n'), extra };
}