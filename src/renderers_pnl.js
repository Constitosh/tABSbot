// src/renderers_pnl.js

function round4(x){ return (Math.round(Number(x)*1e4)/1e4).toFixed(4); }
function money(x, n=2){ return '$'+(Math.round(Number(x)*10**n)/10**n).toFixed(n); }
function pct(x){
  const v = Number(x)||0;
  const s = v >= 0 ? '🟢 +' : '🔴 ';
  return `${s}${Math.abs(v).toFixed(2)}%`;
}
function kfmt(num) {
  const n = Number(num);
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) < 10_000) return String(Math.round(n * 100) / 100);
  if (Math.abs(n) < 1_000_000) return (Math.round(n / 10) / 100).toFixed(2) + 'k';
  if (Math.abs(n) < 1_000_000_000) return (Math.round(n / 10_000) / 100).toFixed(2) + 'm';
  return (Math.round(n / 10_000_000) / 100).toFixed(2) + 'b';
}
function cleanSym(s){ const t=String(s||'').trim(); return t||'Token'; }

function windowButtons(wallet, win, view) {
  const WINS = ['24h','7d','30d','90d','all'];
  const row = WINS.map(w => ({ text: w === win ? `· ${w} ·` : w, callback_data: `pnlv:${wallet}:${w}:${view}` }));
  return [ row ];
}

export function renderPNL(data, win='30d', view='overview') {
  const w = data.wallet;
  const t = data.totals || {};

  const head = [
    `💼 <b>Wallet PnL</b> — <code>${w.slice(0,6)}…${w.slice(-4)}</code>`,
    `Window: ${win}`,
    ``,
    `💧 ETH IN:  ${round4(t.ethIn)}`,
    `🔥 ETH OUT: ${round4(t.ethOut)}`,
    `📈 Realized: ${round4(t.realizedEth)}`,
    `📊 Unrealized: ${round4(t.unrealizedEth)}`,
    `📦 Holdings: ${money(t.holdingsUsd)}`,
    `🎁 Airdrops: ${money(t.airdropsUsd)}`,
    `${t.totalEth >= 0 ? '🟢' : '🔴'} Total PnL: ${round4(t.totalEth)}  (${pct(t.totalPct)})`
  ];

  let body = '';
  let kb = { inline_keyboard: [] };

  if (view === 'overview') {
    const tp = data.topProfits || [];
    const tl = data.topLosses  || [];

    const tpLines = tp.length ? tp.map(x => [
      `• ${cleanSym(x.symbol)} — 🟢`,
      `🟢 ${round4(x.realizedEth)} (${pct(x.realizedPct)})`,
      `Bought ${round4(x.buyEth)}`,
      `Sold ${round4(x.sellEth)}`
    ].join('\n')).join('\n\n') : 'No items';

    const tlLines = tl.length ? tl.map(x => [
      `• ${cleanSym(x.symbol)} — 🔴`,
      `🔴 ${round4(x.realizedEth)} (${pct(x.realizedPct)})`,
      `Bought ${round4(x.buyEth)}`,
      `Sold ${round4(x.sellEth)}`
    ].join('\n')).join('\n\n') : 'No items';

    body = [
      ...head,
      ``,
      `Top Profits (realized)`,
      tpLines,
      ``,
      `Top Losses (realized)`,
      tlLines
    ].join('\n');

    kb.inline_keyboard = [
      [{ text:'📜 Profits', callback_data:`pnlv:${w}:${win}:profits` },
       { text:'📉 Losses',  callback_data:`pnlv:${w}:${win}:losses` }],
      [{ text:'📦 Open',    callback_data:`pnlv:${w}:${win}:open` },
       { text:'🎁 Airdrops',callback_data:`pnlv:${w}:${win}:airdrops` }],
      ...windowButtons(w, win, 'overview'),
      [{ text:'↻ Refresh',  callback_data:`pnl_refresh:${w}:${win}` }]
    ];
  }

  if (view === 'profits') {
    const items = (data.fullProfits || []).map(x => [
      `• ${cleanSym(x.symbol)} — 🟢`,
      `🟢 ${round4(x.realizedEth)} (${pct(x.realizedPct)})`,
      `Bought ${round4(x.buyEth)}`,
      `Sold ${round4(x.sellEth)}`
    ].join('\n')).join('\n\n') || 'No items';

    body = [
      ...head,
      ``,
      `All Profits (realized)`,
      items
    ].join('\n');

    kb.inline_keyboard = [
      [{ text:'🏠 Overview', callback_data:`pnlv:${w}:${win}:overview` },
       { text:'📉 Losses',   callback_data:`pnlv:${w}:${win}:losses` }],
      [{ text:'📦 Open',     callback_data:`pnlv:${w}:${win}:open` },
       { text:'🎁 Airdrops', callback_data:`pnlv:${w}:${win}:airdrops` }],
      ...windowButtons(w, win, 'profits'),
      [{ text:'↻ Refresh',   callback_data:`pnl_refresh:${w}:${win}` }]
    ];
  }

  if (view === 'losses') {
    const items = (data.fullLosses || []).map(x => [
      `• ${cleanSym(x.symbol)} — 🔴`,
      `🔴 ${round4(x.realizedEth)} (${pct(x.realizedPct)})`,
      `Bought ${round4(x.buyEth)}`,
      `Sold ${round4(x.sellEth)}`
    ].join('\n')).join('\n\n') || 'No items';

    body = [
      ...head,
      ``,
      `All Losses (realized)`,
      items
    ].join('\n');

    kb.inline_keyboard = [
      [{ text:'🏠 Overview', callback_data:`pnlv:${w}:${win}:overview` },
       { text:'📜 Profits',  callback_data:`pnlv:${w}:${win}:profits` }],
      [{ text:'📦 Open',     callback_data:`pnlv:${w}:${win}:open` },
       { text:'🎁 Airdrops', callback_data:`pnlv:${w}:${win}:airdrops` }],
      ...windowButtons(w, win, 'losses'),
      [{ text:'↻ Refresh',   callback_data:`pnl_refresh:${w}:${win}` }]
    ];
  }

  if (view === 'open') {
    const items = (data.open || []).map(o => [
      `• ${cleanSym(o.symbol)}`,
      `Hold: ${kfmt(o.heldNum)}`,
      `Now:  ${money(o.usdNow)}`
    ].join('\n')).join('\n\n') || 'No open positions';

    body = [
      ...head,
      ``,
      `Open Positions`,
      items
    ].join('\n');

    kb.inline_keyboard = [
      [{ text:'🏠 Overview', callback_data:`pnlv:${w}:${win}:overview` },
       { text:'📜 Profits',  callback_data:`pnlv:${w}:${win}:profits` }],
      [{ text:'📉 Losses',   callback_data:`pnlv:${w}:${win}:losses` },
       { text:'🎁 Airdrops', callback_data:`pnlv:${w}:${win}:airdrops` }],
      ...windowButtons(w, win, 'open'),
      [{ text:'↻ Refresh',   callback_data:`pnl_refresh:${w}:${win}` }]
    ];
  }

  if (view === 'airdrops') {
    const toks = (data.airdrops?.tokens || []).map(a => `• ${cleanSym(a.symbol)} — qty ${kfmt(a.qty)}`).join('\n') || 'None';
    const nfts = (data.airdrops?.nfts   || []).map(n => `• ${n.name || 'NFT'} — qty ${n.qty}`).join('\n') || 'None';

    body = [
      ...head,
      ``,
      `Token airdrops`,
      toks,
      ``,
      `NFT airdrops`,
      nfts
    ].join('\n');

    kb.inline_keyboard = [
      [{ text:'🏠 Overview', callback_data:`pnlv:${w}:${win}:overview` },
       { text:'📜 Profits',  callback_data:`pnlv:${w}:${win}:profits` }],
      [{ text:'📉 Losses',   callback_data:`pnlv:${w}:${win}:losses` },
       { text:'📦 Open',     callback_data:`pnlv:${w}:${win}:open` }],
      ...windowButtons(w, win, 'airdrops'),
      [{ text:'↻ Refresh',   callback_data:`pnl_refresh:${w}:${win}` }]
    ];
  }

  return { text: body, extra: { reply_markup: kb } };
}