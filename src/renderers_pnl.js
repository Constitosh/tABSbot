// src/renderers_pnl.js
// Renders PnL views + inline keyboards

const wins = ['24h','7d','30d','90d','all'];
const views = [
  { key: 'overview', label: '🏠 Home' },
  { key: 'profits',  label: '🟢 Profits' },
  { key: 'losses',   label: '🔴 Losses' },
  { key: 'open',     label: '📦 Open' },
  { key: 'airdrops', label: '🎁 Airdrops' },
  { key: 'refresh',  label: '↻ Refresh' },
];

const fmt4 = (n) => {
  const x = Number(n || 0);
  return (Math.round(x * 1e4) / 1e4).toFixed(4);
};
const fmtUsd = (n) => {
  const x = Number(n || 0);
  return `$${x.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 0 })}`;
};
const esc = (s='') => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function buildKeyboard(wallet, window, view) {
  const winRow = wins.map(w => ({
    text: w === window ? `· ${w} ·` : w,
    callback_data: `pnlv:${wallet}:${w}:${view}`
  }));

  const rows = [];
  rows.push(winRow);

  // View buttons (map to current window)
  const viewRow1 = [];
  const viewRow2 = [];

  for (const v of views) {
    if (v.key === 'refresh') continue;
    const cur = v.key === view;
    (viewRow1.length < 3 ? viewRow1 : viewRow2).push({
      text: cur ? v.label.replace(/^(..)/,'$1') : v.label,
      callback_data: `pnlv:${wallet}:${window}:${v.key}`
    });
  }
  rows.push(viewRow1);
  rows.push(viewRow2);

  // Refresh
  rows.push([{ text: '↻ Refresh', callback_data: `pnl_refresh:${wallet}:${window}` }]);

  return { inline_keyboard: rows };
}

function isEthLike(t) {
  const s = String(t.symbol || '').toUpperCase();
  return s === 'ETH' || s === 'WETH';
}

function humanQty(unitsStr, decimals) {
  try {
    const q = BigInt(unitsStr || '0');
    const scale = 10n ** BigInt(decimals || 18);
    const n = Number(q) / Number(scale || 1n);
    // pretty up to k/m for > 9999
    if (n < 10000) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
    const k = n / 1_000;
    if (k < 1000) return `${(Math.round(k*100)/100).toLocaleString(undefined,{maximumFractionDigits:2})}k`;
    const m = n / 1_000_000;
    return `${(Math.round(m*100)/100).toLocaleString(undefined,{maximumFractionDigits:2})}m`;
  } catch { return '0'; }
}

function deriveRealizedLists(data) {
  // Only tokens with nonzero realized, exclude ETH/WETH, and "closed" (remaining == 0 or only dust < 5 tokens)
  const out = [];
  for (const t of data.tokens || []) {
    if (isEthLike(t)) continue;
    const realized = Number(t.realizedWeth || 0);
    if (Math.abs(realized) < 1e-12) continue;

    // closed test: remaining == 0, or remaining < 5 tokens
    let closed = false;
    try {
      const rem = BigInt(String(t.remaining || '0'));
      const min = 5n * (10n ** BigInt(t.decimals || 18));
      closed = (rem === 0n) || (rem < min);
    } catch { /* ignore */ }

    if (!closed) continue;

    out.push({
      symbol: t.symbol || '',
      realized,
      pct: (() => {
        const spent = Number(t.totalBuysEth || 0);
        if (spent <= 0) return 0;
        return (realized / spent) * 100;
      })(),
      buysEth: Number(t.totalBuysEth || 0),
      sellsEth: Number(t.totalSellsEth || 0),
      dustLeft: (() => {
        try { return BigInt(String(t.remaining||'0')) > 0n; } catch { return false; }
      })()
    });
  }

  const profits = out.filter(x => x.realized > 0)
                     .sort((a,b)=> b.realized - a.realized).slice(0, 15);
  const losses  = out.filter(x => x.realized < 0)
                     .sort((a,b)=> a.realized - b.realized).slice(0, 15);
  return { profits, losses };
}

function renderOverview(data, window) {
  const w = data.wallet.slice(0,6) + '…' + data.wallet.slice(-4);
  const t = data.totals || {};

  const totalPnl = Number(t.totalPnlWeth || 0);
  const pct      = Number(t.pnlPct || 0);
  const colorDot = totalPnl > 0 ? '🟢' : (totalPnl < 0 ? '🔴' : '⚪️');

  const header = [
    `💼 <b>Wallet PnL — ${esc(w)}</b>`,
    `<i>Window: ${esc(window)}</i>`,
    `💰 <b>Wallet Balance:</b> ${fmt4(t.ethBalance||0)} ETH`,
    '',
    `💧 <b>ETH IN:</b> ${fmt4(t.ethInFloat||0)} ETH`,
    `🔥 <b>ETH OUT:</b> ${fmt4(t.ethOutFloat||0)} ETH`,
    `📈 <b>Realized:</b> ${fmt4(t.realizedWeth||0)} ETH`,
    `📊 <b>Unrealized:</b> ${fmt4(t.unrealizedWeth||0)} ETH`,
    `📦 <b>Holdings:</b> ${fmtUsd(t.holdingsUsd||0)}`,
    `🎁 <b>Airdrops:</b> ${fmtUsd(t.airdropsUsd||0)}`,
    `${colorDot} <b>Total PnL:</b> ${fmt4(totalPnl)} ETH  (${totalPnl>0?'🟢':'🔴'} ${fmt4(Math.abs(pct))}%)`,
    ''
  ].join('\n');

  const { profits, losses } = deriveRealizedLists(data);

  const profLines = profits.length
    ? profits.map(p => [
        `• ${esc(p.symbol)} — 🟢 +${fmt4(p.realized)} ETH (🟢 +${fmt4(p.pct)}%)`,
        `Bought ${fmt4(p.buysEth)} ETH`,
        `Sold ${fmt4(p.sellsEth)} ETH`,
        ''
      ].join('\n')).join('\n')
    : 'No items';

  const lossLines = losses.length
    ? losses.map(p => [
        `• ${esc(p.symbol)} — 🔴 −${fmt4(Math.abs(p.realized))} ETH (🔴 -${fmt4(Math.abs(p.pct))}%)`,
        `Bought ${fmt4(p.buysEth)} ETH`,
        `Sold ${fmt4(p.sellsEth)} ETH`,
        ''
      ].join('\n')).join('\n')
    : 'No items';

  const body = [
    `<b>Top Profits (realized)</b>`,
    profLines,
    '',
    `<b>Top Losses (realized)</b>`,
    lossLines
  ].join('\n');

  return header + '\n' + body;
}

function renderProfits(data) {
  const { profits } = deriveRealizedLists(data);
  if (!profits.length) return '<b>Top Profits (realized)</b>\nNo items';
  const out = ['<b>Top Profits (realized)</b>',''];
  for (const p of profits) {
    out.push(`• ${esc(p.symbol)} — 🟢 +${fmt4(p.realized)} ETH (🟢 +${fmt4(p.pct)}%)`);
    out.push(`Bought ${fmt4(p.buysEth)} ETH`);
    out.push(`Sold ${fmt4(p.sellsEth)} ETH`);
    out.push(''); // blank line between tokens
  }
  return out.join('\n');
}

function renderLosses(data) {
  const { losses } = deriveRealizedLists(data);
  if (!losses.length) return '<b>Top Losses (realized)</b>\nNo items';
  const out = ['<b>Top Losses (realized)</b>',''];
  for (const p of losses) {
    out.push(`• ${esc(p.symbol)} — 🔴 −${fmt4(Math.abs(p.realized))} ETH (🔴 -${fmt4(Math.abs(p.pct))}%)`);
    out.push(`Bought ${fmt4(p.buysEth)} ETH`);
    out.push(`Sold ${fmt4(p.sellsEth)} ETH`);
    out.push('');
  }
  return out.join('\n');
}

function renderOpen(data) {
  const rows = [];
  for (const t of (data.derived?.open || [])) {
    if (isEthLike(t)) continue;
    const usd = Number(t.usdValueRemaining || 0);
    if (usd < 1) continue; // hide <$1
    rows.push(`• ${esc(t.symbol)} — ${fmtUsd(usd)}\nHoldings: ${humanQty(t.remaining, t.decimals)}`);
    rows.push('');
  }
  if (!rows.length) return '<b>Open Positions</b>\nNo items';
  return ['<b>Open Positions</b>','', ...rows].join('\n');
}

function renderAirdrops(data) {
  const drops = (data.derived?.airdrops || []).filter(d => !isEthLike(d));
  if (!drops.length) return '<b>Airdrops</b>\nNo items';
  const out = ['<b>Airdrops</b>',''];
  for (const d of drops) {
    out.push(`• ${esc(d.symbol)} — est ${fmtUsd(d.estUsd||0)}`);
  }
  return out.join('\n');
}

// Main export
export function renderPNL(data, window='30d', view='overview') {
  const wallet = String(data.wallet).toLowerCase();
  let text = '';
  switch (view) {
    case 'profits': text = renderProfits(data); break;
    case 'losses':  text = renderLosses(data);  break;
    case 'open':    text = renderOpen(data);    break;
    case 'airdrops':text = renderAirdrops(data);break;
    default:        text = renderOverview(data, window);
  }
  const kb = buildKeyboard(wallet, window, view);
  return {
    text,
    extra: {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: kb
    }
  };
}