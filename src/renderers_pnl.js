// src/renderers_pnl.js
import { Markup } from 'telegraf';

// helpers
const fmt4 = (x) => {
  const n = Number(x || 0);
  return (Math.round(n * 1e4) / 1e4).toFixed(4);
};
const pct = (x) => {
  const n = Number(x || 0);
  const s = n >= 0 ? '🟢' : '🔴';
  const v = Math.abs(n).toFixed(2);
  const sign = n >= 0 ? '+' : '−';
  return `${s} ${sign}${v}%`;
};
const ethSign = (x) => {
  const n = Number(x || 0);
  const s = n >= 0 ? '🟢' : '🔴';
  const sign = n >= 0 ? '+' : '−';
  return `${s} ${sign}${fmt4(Math.abs(n))} ETH`;
};
const kfmtUnits = (units) => {
  // format token unit counts into 10k / 135.45k / 3.34m etc.
  const n = Number(units || 0);
  if (Math.abs(n) < 10000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (Math.abs(n) < 1_000_000) return (n/1_000).toFixed(2).replace(/\.00$/, '') + 'k';
  if (Math.abs(n) < 1_000_000_000) return (n/1_000_000).toFixed(2).replace(/\.00$/, '') + 'm';
  return (n/1_000_000_000).toFixed(2).replace(/\.00$/, '') + 'b';
};
const isEthLike = (sym='') => {
  const s = String(sym).trim().toUpperCase();
  return s === 'ETH' || s === 'WETH';
};
const dustClosed = (remainingStr, decimals) => {
  try {
    const rem = BigInt(String(remainingStr || '0'));
    const th  = 5n * (10n ** BigInt(Math.max(0, Number(decimals||0))));
    return rem === 0n || rem < th;
  } catch { return true; }
};

const nav = (wallet, window, view) => {
  const w = wallet.toLowerCase();
  const winBtns = [
    ['24h','7d','30d','90d','all'].map(k => Markup.button.callback(
      k === window ? `· ${k} ·` : k,
      `pnlv:${w}:${k}:${view}`
    ))
  ];
  const views = [
    [
      Markup.button.callback(view==='overview'?'· Overview ·':'Overview', `pnlv:${w}:${window}:overview`),
      Markup.button.callback(view==='profits' ?'· Profits ·' :'Profits',  `pnlv:${w}:${window}:profits`),
      Markup.button.callback(view==='losses'  ?'· Losses ·'  :'Losses',   `pnlv:${w}:${window}:losses`),
    ],
    [
      Markup.button.callback(view==='open'    ?'· Open ·'    :'Open',     `pnlv:${w}:${window}:open`),
      Markup.button.callback(view==='airdrops'?'· Airdrops ·':'Airdrops', `pnlv:${w}:${window}:airdrops`),
    ],
    [
      Markup.button.callback('Refresh', `pnl_refresh:${w}:${window}`),
    ]
  ];
  return Markup.inlineKeyboard([...winBtns, ...views]);
};

function buildTopLists(data) {
  // Recompute realized leaders from raw tokens to enforce: closed/dust-left only, exclude ETH/WETH, exclude zero PnL
  const items = [];
  for (const t of (data.tokens || [])) {
    if (isEthLike(t.symbol)) continue;
    const realized = Number(t.realizedWeth || 0);
    if (Math.abs(realized) < 1e-9) continue; // drop 0 pnl
    if (!dustClosed(t.remaining, t.decimals)) continue; // only closed/dust-left

    const buyEth  = Number(t.totalBuysEth || 0);
    const sellEth = Number(t.totalSellsEth || 0);
    const spent   = buyEth;
    const ret     = sellEth;
    const pnlPct  = spent > 0 ? ((ret - spent) / spent) * 100 : 0;

    items.push({
      symbol: t.symbol || '',
      realized,
      buyEth,
      sellEth,
      pnlPct
    });
  }
  const profits = items.filter(x => x.realized > 0).sort((a,b)=> b.realized - a.realized);
  const losses  = items.filter(x => x.realized < 0).sort((a,b)=> a.realized - b.realized);
  return { profits, losses };
}

function renderOverview(data, window) {
  const w = data.wallet?.slice(0,6) + '…' + data.wallet?.slice(-4);
  const t = data.totals || {};
  const totalPnl = Number(t.totalPnlWeth || 0);
  const pnlColor = totalPnl > 0 ? '🟢' : (totalPnl < 0 ? '🔴' : '⚪️');

  const { profits, losses } = buildTopLists(data);
  const topP = profits.slice(0,3);
  const topL = losses.slice(0,3);

  let text = '';
  text += `💼 <b>Wallet PnL — ${w}</b>\n`;
  text += `Window: ${window}\n`;
  text += `💰 <b>Wallet Balance:</b> ${fmt4(t.ethBalance)} ETH\n\n`;

  text += `💧 <b>ETH IN:</b> ${fmt4(t.ethInFloat)} ETH\n`;
  text += `🔥 <b>ETH OUT:</b> ${fmt4(t.ethOutFloat)} ETH\n`;
  text += `📈 <b>Realized:</b> ${fmt4(t.realizedWeth)} ETH\n`;
  text += `📊 <b>Unrealized:</b> ${fmt4(t.unrealizedWeth)} ETH\n`;
  text += `📦 <b>Holdings:</b> $${Math.round(Number(t.holdingsUsd||0))}\n`;
  text += `🎁 <b>Airdrops:</b> $${fmt4(Number(t.airdropsUsd||0))}\n`;
  text += `${pnlColor} <b>Total PnL:</b> ${fmt4(totalPnl)} ETH  (${pct(t.pnlPct)})\n\n`;

  // Top profits
  text += `<b>Top Profits (realized)</b>\n`;
  if (topP.length === 0) {
    text += `No items\n\n`;
  } else {
    for (const i of topP) {
      const sign = i.realized >= 0 ? '🟢' : '🔴';
      text += `• ${i.symbol} — ${sign}\n`;
      text += `${ethSign(i.realized)} (${pct(i.pnlPct)})\n`;
      text += `Bought ${fmt4(i.buyEth)} ETH\n`;
      text += `Sold ${fmt4(i.sellEth)} ETH\n\n`;
    }
  }

  // Top losses
  text += `<b>Top Losses (realized)</b>\n`;
  if (topL.length === 0) {
    text += `No items\n`;
  } else {
    for (const i of topL) {
      const sign = i.realized >= 0 ? '🟢' : '🔴';
      text += `• ${i.symbol} — ${sign}\n`;
      text += `${ethSign(i.realized)} (${pct(i.pnlPct)})\n`;
      text += `Bought ${fmt4(i.buyEth)} ETH\n`;
      text += `Sold ${fmt4(i.sellEth)} ETH\n\n`;
    }
  }

  return { text, extra: { reply_markup: nav(data.wallet, window, 'overview') } };
}

function renderProfits(data, window) {
  const { profits } = buildTopLists(data);
  let text = `<b>Top Profits (realized)</b>\n`;
  if (profits.length === 0) {
    text += `No items`;
  } else {
    for (const i of profits) {
      text += `• ${i.symbol} — 🟢\n`;
      text += `${ethSign(i.realized)} (${pct(i.pnlPct)})\n`;
      text += `Bought ${fmt4(i.buyEth)} ETH\n`;
      text += `Sold ${fmt4(i.sellEth)} ETH\n\n`;
    }
  }
  return { text, extra: { reply_markup: nav(data.wallet, window, 'profits') } };
}

function renderLosses(data, window) {
  const { losses } = buildTopLists(data);
  let text = `<b>Top Losses (realized)</b>\n`;
  if (losses.length === 0) {
    text += `No items`;
  } else {
    for (const i of losses) {
      text += `• ${i.symbol} — 🔴\n`;
      text += `${ethSign(i.realized)} (${pct(i.pnlPct)})\n`;
      text += `Bought ${fmt4(i.buyEth)} ETH\n`;
      text += `Sold ${fmt4(i.sellEth)} ETH\n\n`;
    }
  }
  return { text, extra: { reply_markup: nav(data.wallet, window, 'losses') } };
}

function renderOpen(data, window) {
  // open = remaining > 0, hide ETH/WETH, hide <$1 value
  const open = (data.tokens || [])
    .filter(t => !isEthLike(t.symbol))
    .filter(t => Number(t.remaining || 0) > 0)
    .filter(t => Number(t.usdValueRemaining || 0) >= 1)
    .sort((a,b)=> Number(b.usdValueRemaining||0) - Number(a.usdValueRemaining||0));

  let text = `<b>Open Positions</b>\n`;
  if (open.length === 0) {
    text += `No items`;
  } else {
    for (const t of open) {
      // token units pretty
      const units = Number(t.remaining || 0) / Math.pow(10, Number(t.decimals||0));
      text += `• ${t.symbol}: ${kfmtUnits(units)}  —  $${(Number(t.usdValueRemaining||0)).toFixed(2)}\n`;
    }
  }
  return { text, extra: { reply_markup: nav(data.wallet, window, 'open') } };
}

function renderAirdrops(data, window) {
  // Token airdrops (ERC20) + NFT airdrops; hide ETH/WETH
  const tokenDrops = (data.derived?.airdrops || [])
    .filter(x => (x.symbol && !isEthLike(x.symbol)))
    .filter(x => Number(x.estUsd || 0) >= 1)
    .sort((a,b)=> Number(b.estUsd||0) - Number(a.estUsd||0));

  const nftDrops = (data.derived?.nfts || [])
    .filter(x => Number(x.count||0) > 0);

  let text = `<b>Airdrops</b>\n`;
  if (tokenDrops.length === 0 && nftDrops.length === 0) {
    text += `No items`;
    return { text, extra: { reply_markup: nav(data.wallet, window, 'airdrops') } };
  }

  if (tokenDrops.length > 0) {
    text += `<u>Tokens</u>\n`;
    for (const x of tokenDrops) {
      text += `• ${x.symbol}: ~$${(Number(x.estUsd||0)).toFixed(2)}\n`;
    }
    text += `\n`;
  }

  if (nftDrops.length > 0) {
    text += `<u>NFTs</u>\n`;
    for (const n of nftDrops) {
      text += `• ${n.collection}: ${n.count}\n`;
    }
  }

  return { text, extra: { reply_markup: nav(data.wallet, window, 'airdrops') } };
}

export function renderPNL(data, window, view='overview') {
  try {
    if (view === 'profits') return renderProfits(data, window);
    if (view === 'losses')  return renderLosses(data, window);
    if (view === 'open')    return renderOpen(data, window);
    if (view === 'airdrops')return renderAirdrops(data, window);
    return renderOverview(data, window);
  } catch (e) {
    const fallback = 'PNL: render error.';
    return { text: fallback, extra: {} };
  }
}