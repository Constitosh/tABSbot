// src/renderers_pnl.js
import { esc, money } from './ui_html.js';

function fmtWETH(w){ return `${(Number(w)/1).toFixed(6)} WETH`; }
function fmtWeiWETH(wei){ return `${(Number(wei)/1e18).toFixed(6)} WETH`; }

export function renderPNL(data, window='30d'){
  const w = esc(data.wallet);
  const t = data.totals||{};
  const lines = [];

  lines.push(`💼 <b>PNL — ${w}</b>`);
  lines.push(`<i>Window: ${window}</i>`);
  lines.push('');
  lines.push(`WETH IN:  <b>${fmtWeiWETH(t.wethIn||'0')}</b>`);
  lines.push(`WETH OUT: <b>${fmtWeiWETH(t.wethOut||'0')}</b>`);
  lines.push(`Realized: <b>${fmtWETH(t.realizedWeth||0)}</b>`);
  lines.push(`Unrealized (mark): <b>${fmtWETH(t.unrealizedWeth||0)}</b>`);
  lines.push(`Airdrops (est USD): <b>${esc(money(t.airdropsUsd||0))}</b>`);
  lines.push('');
  lines.push(`<b>Top 15 tokens (by abs PnL)</b>`);

  const rows = (data.tokens||[])
    .map(r => {
      const realized = Number(r.realizedWeth||0);
      const unreal = Number(r.unrealizedWeth||0);
      const abs = Math.abs(realized)+Math.abs(unreal);
      return { r, score: abs };
    })
    .sort((a,b)=> b.score-a.score)
    .slice(0,15);

  if (!rows.length) lines.push('<i>No token trades found in this window.</i>');

  for (const {r} of rows){
    lines.push(
      `• <b>${esc(r.symbol||r.token.slice(0,6))}</b> — ` +
      `buy ${(Number(r.buys)/10**r.decimals).toFixed(4)}, ` +
      `sell ${(Number(r.sells)/10**r.decimals).toFixed(4)}, ` +
      `rem ${(Number(r.remaining)/10**r.decimals).toFixed(4)} — ` +
      `real ${fmtWETH(Number(r.realizedWeth)/1)}, ` +
      `unreal ${fmtWETH(Number(r.unrealizedWeth)/1)}`
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
          { text:'🏠 Back',    callback_data:`about` }
        ]
      ]
    }
  };

  return { text: lines.join('\n'), extra };
}
