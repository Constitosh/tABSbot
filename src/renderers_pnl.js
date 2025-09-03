// src/renderers_pnl.js
import { esc, money } from './ui_html.js';

const shortAddr = (a) => a ? (a.slice(0,6) + '…' + a.slice(-4)) : '';
const signETH = (x) => (x > 0 ? '+' : (x < 0 ? '−' : '±'));
const fmtETH = (w) => `${Number(w).toFixed(6)} ETH`;
const fmtUSD = (u) => money(Number(u)||0);
const fmtQty = (units, decimals) => {
  const n = Number(units)/10**decimals;
  if (!isFinite(n) || n === 0) return '0';
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toPrecision(4);
};

// UI: window chips + views
function headerChips(wallet, window, view){
  const windows = ['24h','7d','30d','90d','all'];
  const viewBtns1 = [
    { text: view==='overview' ? '· Overview ·' : 'Overview', callback_data:`pnlview:${wallet}:${window}:overview` },
    { text: view==='profits'  ? '· Profits ·'  : 'Profits',  callback_data:`pnlview:${wallet}:${window}:profits` },
    { text: view==='losses'   ? '· Losses ·'   : 'Losses',   callback_data:`pnlview:${wallet}:${window}:losses` },
  ];
  const viewBtns2 = [
    { text: view==='open'     ? '· Open ·'     : 'Open',     callback_data:`pnlview:${wallet}:${window}:open` },
    { text: view==='airdrops' ? '· Airdrops ·' : 'Airdrops', callback_data:`pnlview:${wallet}:${window}:airdrops` },
  ];
  return {
    inline_keyboard: [
      windows.map(w => ({
        text: w === window ? `· ${w} ·` : w,
        callback_data: `pnlview:${wallet}:${w}:${view}`
      })),
      viewBtns1,
      viewBtns2,
      [
        { text:'↻ Refresh', callback_data:`pnl_refresh:${wallet}:${window}` },
        { text:'🏠 Back',    callback_data:'about' }
      ]
    ]
  };
}

function lineToken(sym, extra) {
  return `• <b>${esc(sym)}</b> — ${extra}`;
}

function topNLabeled(list, label, fmtRow, limit=15) {
  const lines = [];
  lines.push(`\n<b>${label}</b>`);
  if (!list.length) {
    lines.push('<i>None</i>');
  } else {
    for (const r of list.slice(0, limit)) lines.push(fmtRow(r));
  }
  return lines;
}

export function renderPNL(data, window='30d', view='overview'){
  const w = esc(data.wallet);
  const t = data.totals || {};
  const d = data.derived || {};
  const tokens = Array.isArray(data.tokens) ? data.tokens : [];

  const lines = [];
  lines.push(`💼 <b>Wallet PnL — ${shortAddr(w)}</b>`);
  lines.push(`<i>Window: ${esc(window)}</i>`);
  lines.push('');

  // Combined ETH view (ETH + WETH)
  const baseIn  = Number(t.baseInFloat||0);
  const baseOut = Number(t.baseOutFloat||0);
  const realized = Number(t.realizedWeth||0);
  const unreal   = Number(t.unrealizedWeth||0);
  const totalPnl = Number(t.totalPnlWeth||0);
  const pnlPct   = Number(t.pnlPct||0);
  const holdingsUsd = Number(t.holdingsUsd||0);
  const airdropsUsd = Number(t.airdropsUsd||0);

  // Overview header
  if (view === 'overview'){
    lines.push(
      [
        `💧 <b>ETH IN:</b> ${esc(fmtETH(baseIn))}`,
        `🔥 <b>ETH OUT:</b> ${esc(fmtETH(baseOut))}`
      ].join('   ·   ')
    );
    lines.push(
      [
        `📈 <b>Realized:</b> ${esc(fmtETH(realized))}`,
        `📊 <b>Unrealized:</b> ${esc(fmtETH(unreal))}`,
        `📦 <b>Holdings:</b> ${esc(fmtUSD(holdingsUsd))}`,
        `🎁 <b>Airdrops:</b> ${esc(fmtUSD(airdropsUsd))}`,
      ].join('   ·   ')
    );
    lines.push(
      `🧮 <b>Total PnL:</b> ${esc(fmtETH(totalPnl))}  (${signETH(pnlPct)}${Math.abs(pnlPct).toFixed(2)}%)`
    );

    // Best/Worst samples (realized-only, closed)
    const best = Array.isArray(d.best) ? d.best : [];
    const worst = Array.isArray(d.worst) ? d.worst : [];

    const fmtRow = (r) =>
      lineToken(r.symbol || r.token.slice(0,6),
        `${signETH(r.realizedWeth)}${Math.abs(Number(r.realizedWeth)||0).toFixed(6)} ETH`
      );

    lines.push(...topNLabeled(best.slice(0,3), 'Top Profits (realized)', fmtRow, 3));
    lines.push(...topNLabeled(worst.slice(0,3), 'Top Losses (realized)', fmtRow, 3));
  }

  // Profits view (closed, realized > 0)
  if (view === 'profits'){
    const rows = Array.isArray(d.profits) ? d.profits : [];
    const fmtRow = (r) =>
      lineToken(r.symbol || r.token.slice(0,6),
        `realized ${signETH(r.realizedWeth)}${Math.abs(Number(r.realizedWeth)||0).toFixed(6)} ETH`
      );
    lines.push(...topNLabeled(rows, 'Top 15 Profits (closed positions)', fmtRow, 15));
  }

  // Losses view (closed, realized < 0)
  if (view === 'losses'){
    const rows = Array.isArray(d.losses) ? d.losses : [];
    const fmtRow = (r) =>
      lineToken(r.symbol || r.token.slice(0,6),
        `realized ${signETH(r.realizedWeth)}${Math.abs(Number(r.realizedWeth)||0).toFixed(6)} ETH`
      );
    lines.push(...topNLabeled(rows, 'Top 15 Losses (closed positions)', fmtRow, 15));
  }

  // Open positions (remaining ≥ 5 tokens; value > $0)
  if (view === 'open'){
    const rows = Array.isArray(d.open) ? d.open : [];
    if (!rows.length) {
      lines.push('\n<b>Open Positions</b>');
      lines.push('<i>None</i>');
    } else {
      lines.push('\n<b>Open Positions</b>');
      for (const r of rows.slice(0, 50)) {
        const dec = Number(r.decimals||18);
        const rem = fmtQty(r.remaining, dec);
        const value = Number(r.usdValueRemaining||0);
        const unreal = Number(r.unrealizedWeth||0);
        lines.push(
          `• <b>${esc(r.symbol || r.token.slice(0,6))}</b> — rem ${esc(rem)} · value ${esc(fmtUSD(value))}\n` +
          `   unreal ${signETH(unreal)}${Math.abs(unreal).toFixed(6)} ETH`
        );
      }
    }
  }

  // Airdrops
  if (view === 'airdrops'){
    const rows = Array.isArray(d.airdrops) ? d.airdrops : [];
    if (!rows.length) {
      lines.push('\n<b>Airdrops</b>');
      lines.push('<i>None</i>');
    } else {
      lines.push('\n<b>Airdrops</b>');
      for (const r of rows.slice(0, 50)) {
        lines.push(
          `• <b>${esc(r.symbol || r.token.slice(0,6))}</b> — est ${esc(fmtUSD(r.estUsd||0))}`
        );
      }
    }
  }

  const extra = { reply_markup: headerChips(w, window, view) };
  return { text: lines.join('\n'), extra };
}
