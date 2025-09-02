// src/renderers_pnl.js
import { esc, money } from './ui_html.js';

const fmtWeth = (n) => `${Number(n).toFixed(6)} WETH`;
const fmtWeiWeth = (wei) => `${(Number(wei)/1e18).toFixed(6)} WETH`;

export function renderPNL(data, window='30d') {
  const w = esc(data.wallet);
  const t = data.totals || {};
  const lines = [];

  lines.push(`💼 <b>Wallet PnL — ${w}</b>`);
  lines.push(`<i>Window: ${window}</i>`);
  lines.push('');
  lines.push(`WETH IN:  <b>${fmtWeiWeth(t.wethIn||'0')}</b>`);
  lines.push(`WETH OUT: <b>${fmtWeiWeth(t.wethOut||'0')}</b>`);
  lines.push(`Realized: <b>${fmtWeth(t.realizedWeth||0)}</b>`);
  lines.push(`Unrealized (mark): <b>${fmtWeth(t.unrealizedWeth||0)}</b>`);
  lines.push(`Airdrops (est USD): <b>${esc(money(t.airdropsUsd||0))}</b>`);
  lines.push('');
  lines.push(`<b>Top 15 tokens (by |real|+|unreal|)</b>`);

  const rows = (data.tokens||[])
    .map(r => {
      const realized = Number(r.realizedWeth||0)/1; // already float WETH after division in worker
      const unreal   = Number(r.unrealizedWeth||0);
      const score    = Math.abs(realized) + Math.abs(unreal);
      return { r, score };
    })
    .sort((a,b)=> b.score - a.score)
    .slice(0,15);

  if (!rows.length) lines.push('<i>No token trades found in this window.</i>');

  for (const {r} of rows) {
    const d = r.decimals || 18;
    const toNum = (s) => Number(s)/10**d;
    lines.push(
      `• <b>${esc(r.symbol||r.token.slice(0,6))}</b> — ` +
      `buy ${toNum(r.buys).toFixed(4)}, ` +
      `sell ${toNum(r.sells).toFixed(4)}, ` +
      `rem ${toNum(r.remaining).toFixed(4)} — ` +
      `real ${fmtWeth(Number(r.realizedWeth)/1e18)}, ` +
      `unreal ${fmtWeth(r.unrealizedWeth||0)}`
    );
  }

  const extra = {
    reply_markup: {
      inline_keyboard: [
        [
          { text:'24h',  callback_data:`pnl:${w}:24h` },
          { text:'7d',   callback_data:`pnl:${w}:7d` },
          { text:'30d',  callback_data:`pnl:${w}:30d` },
          { text:'365d', callback_data:`pnl:${w}:365d` },
          { text:'All',  callback_data:`pnl:${w}:all` },
        ],
        [
          { text:'↻ Refresh', callback_data:`pnl_refresh:${w}:${window}` },
          { text:'🏠 Back',    callback_data:'about' }
        ]
      ]
    }
  };

  return { text: lines.join('\n'), extra };
}
