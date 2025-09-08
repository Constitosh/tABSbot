// src/renderers_pnl.js
// Telegram-safe HTML renderers for PnL
import { esc } from './ui_html.js';

const BR = '\u200B'; // forced blank line

// ----- number formatting -----
const fmtEth = (x) => (Number(x||0)).toFixed(4);
function fmtPct(x) {
  const n = Number(x||0);
  const s = (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
  return s;
}
function abbrTokens(units, decimals) {
  // show plain up to 9,999; then k/m with 2 decimals
  const n = Number(units) / Math.max(1, Number(10 ** (decimals||0)));
  if (!isFinite(n)) return '0';
  if (Math.abs(n) < 10000) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs < 1e6) return sign + (abs/1e3).toFixed(2) + 'k';
  if (abs < 1e9) return sign + (abs/1e6).toFixed(2) + 'm';
  return sign + (abs/1e9).toFixed(2) + 'b';
}

// Build buy/sell totals & realized list (closed or partial)
function buildRealizedLists(tokens) {
  // For each token we only have realizedWeth (sum of partial sells).
  // We also want totalBuyEth & totalSellEth to show beneath each line.
  // Re-derive from per-token movements: approximate via avg cost math:
  // Here we sum realized (provided) and estimate buy/sell legs from realized sign + inventory cost.
  // Simpler: we recompute buy/sell legs from deltas embedded in the token object:
  //   buys = token.buys units at effective avg cost ~ (inventoryCost + costOfSold)
  // But we didn't persist costOfSold. So we’ll show a compact line:
  //   "Bought X ETH · Sold Y ETH" using realized + priceWeth snapshots is unreliable.
  // Therefore we’ll derive per token: totalBuyEth ~ inventoryCostWeth + realizedPositiveAdds
  // and totalSellEth ~ realizedPositiveAdds - realizedNegativeAbs + ??? — This gets hairy.
  //
  // Better: we show realized PnL and omit the buy/sell split if we cannot guarantee exactness.
  // Per user request we *do* want those lines. We'll approximate:
  //   Let r = realizedWeth. Let inv = inventoryCostWeth, priceWeth = priceWeth, remaining = units.
  //   We can't recover historical exact buy/sell ETH without replaying legs. That’s done in worker now
  //   via tradeOutEth and tradeInEth at totals, but not per-token split. So:
  // Update: we will compute per-token "avg buy price" and "sold ETH" by allocating trade flows
  // from realizedWeth using avg-cost: SoldEth = CostOfSold + Realized (unknown CostOfSold).
  // We can't reconstruct CostOfSold. So instead, show **Bought/Sold in UNITS** and keep PnL ETH accurate.
  //
  // That matches the user's latest requirement to see tokens bought, tokens sold, tokens held.
  const realized = [];
  for (const t of (tokens||[])) {
    const remUnits = BigInt(t.remaining||'0');
    const buyUnits = BigInt(t.buys||'0');
    const sellUnits = BigInt(t.sells||'0');
    const pnl = Number(t.realizedWeth)||0;

    // closed if remaining == 0
    const closed = remUnits === 0n;
    realized.push({
      token: t.token,
      symbol: t.symbol || '—',
      pnl,
      closed,
      buysUnits: buyUnits,
      sellsUnits: sellUnits,
      decimals: t.decimals||18,
      priceWeth: Number(t.priceWeth||0),
    });
  }
  return realized;
}

function colorDot(n) {
  if (n > 0) return '🟢';
  if (n < 0) return '🔴';
  return '⚪️';
}

function rankTop(realizedAll) {
  const arr = buildRealizedLists(realizedAll);
  const pos = arr.filter(x => x.pnl > 0).sort((a,b)=> b.pnl - a.pnl);
  const neg = arr.filter(x => x.pnl < 0).sort((a,b)=> a.pnl - b.pnl);
  return { pos, neg };
}

function buildHeader(data, window) {
  const bal = fmtEth(data.totals.ethBalance);
  const ein = fmtEth(data.totals.tradeInEth || 0);
  const eout= fmtEth(data.totals.tradeOutEth || 0);
  const realized = fmtEth(data.totals.realizedWeth || 0);
  const unreal   = fmtEth(data.totals.unrealizedWeth || 0);
  const holdUsd  = (data.totals.holdingsUsd || 0);
  const adUsd    = (data.totals.airdropsUsd || 0);
  const total    = fmtEth(data.totals.totalPnlWeth || 0);
  const pct      = Number(data.totals.pnlPct||0);
  const pcStr    = (pct>=0?`🟢 +${pct.toFixed(2)}%`:`🔴 ${pct.toFixed(2)}%`);
  const dot      = (Number(total)>0?'🟢':Number(total)<0?'🔴':'⚪️');

  return [
    `💼 <b>Wallet PnL — <code>${esc(data.wallet.slice(0,6))}…${esc(data.wallet.slice(-4))}</code></b>`,
    `Window: ${esc(window)}`,
    `💰 Wallet Balance: ${bal} ETH`,
    BR,
    `💧 ETH IN: ${ein} ETH`,
    `🔥 ETH OUT: ${eout} ETH`,
    `📈 Realized: ${realized} ETH`,
    `📊 Unrealized: ${unreal} ETH`,
    `📦 Holdings: $${Math.round(holdUsd).toLocaleString()}`,
    `🎁 Airdrops: $${adUsd.toFixed(2)}`,
    `${dot} Total PnL: ${total} ETH  (${pcStr})`,
    BR,
  ].join('\n');
}

function lineRealized(r) {
  const dot = colorDot(r.pnl);
  const pnl = `${dot} ${r.pnl>=0?'+':''}${fmtEth(r.pnl)} ETH`;
  // show units bought/sold/held — per user: units scaled & abbreviated
  const boughtU = abbrTokens(r.buysUnits.toString(), r.decimals);
  const soldU   = abbrTokens(r.sellsUnits.toString(), r.decimals);
  const heldU   = abbrTokens((BigInt(r.buysUnits)-BigInt(r.sellsUnits)).toString(), r.decimals);
  return [
    `• ${esc(r.symbol||'—')} — ${dot}`,
    `${pnl}`,
    `Bought ${boughtU}`,
    `Sold ${soldU}`,
    BR,
  ].join('\n');
}

function renderTopSection(pos, neg, limitPos=3, limitNeg=3) {
  const topP = pos.slice(0, limitPos).map(lineRealized).join('\n') || 'No items';
  const topL = neg.slice(0, limitNeg).map(lineRealized).join('\n') || 'No items';
  return [
    `<b>Top Profits (realized)</b>`,
    topP,
    `<b>Top Losses (realized)</b>`,
    topL,
  ].join('\n');
}

function viewButtons(wallet, window, active) {
  const views = [
    ['overview','🏠 Overview'],
    ['profits','🟢 Profits'],
    ['losses','🔴 Losses'],
    ['open','📦 Open'],
    ['airdrops','🎁 Airdrops'],
  ];
  const row1 = views.map(([v,label]) => ({
    text: v===active ? `● ${label}` : label,
    callback_data: `pnlv:${wallet}:${window}:${v}`
  }));
  const windows = ['24h','7d','30d','90d','all'];
  const row2 = windows.map(w => ({
    text: (w===window ? `● ${w}` : w),
    callback_data: `pnl:${wallet}:${w}`
  }));
  const row3 = [{ text:'↻ Refresh', callback_data:`pnl_refresh:${wallet}:${window}`}];

  return {
    reply_markup: { inline_keyboard: [ row1, row2, row3 ] }
  };
}

export function renderPNL(data, window='30d', view='overview') {
  const hdr = buildHeader(data, window);
  const { pos, neg } = rankTop(data.tokens || []);

  if (view === 'profits') {
    const body = pos.map(lineRealized).join('\n') || 'No items';
    return { text: [hdr, `<b>Profits (realized, ordered)</b>`, body].join('\n'),
             extra: viewButtons(data.wallet, window, 'profits') };
  }
  if (view === 'losses') {
    const body = neg.map(lineRealized).join('\n') || 'No items';
    return { text: [hdr, `<b>Losses (realized, ordered)</b>`, body].join('\n'),
             extra: viewButtons(data.wallet, window, 'losses') };
  }
  if (view === 'open') {
    const opens = (data.derived?.open||[]).slice().sort((a,b)=> (b.usdValueRemaining||0)-(a.usdValueRemaining||0));
    const body = opens.map(o=>{
      const heldU = abbrTokens(o.remaining, o.decimals);
      const val = `$${(o.usdValueRemaining||0).toFixed(2)}`;
      // % vs avg buy = if inventoryCost>0 then (MTM / inventoryCost - 1)*100
      const invCost = Number(o.inventoryCostWeth||0);
      const mtm = Number(o.unrealizedWeth||0) + invCost;
      const p = invCost>0 ? ((mtm/invCost - 1)*100) : 0;
      return `• ${esc(o.symbol||'—')} — ${heldU}\nValue ${val}  ·  ${p>=0?`🟢 +${p.toFixed(2)}%`:`🔴 ${p.toFixed(2)}%`}`;
    }).join('\n\n') || 'No open positions ≥ $1';
    return { text: [hdr, `<b>Open Positions</b>`, body].join('\n'),
             extra: viewButtons(data.wallet, window, 'open') };
  }
  if (view === 'airdrops') {
    const lines = [];
    const erc20Drops = (data.tokens||[]).filter(t => (t.airdrops?.count||0)>0);
    if (erc20Drops.length) {
      lines.push('<b>Token Airdrops</b>');
      lines.push(
        erc20Drops.map(t=>{
          const units = abbrTokens(t.airdrops.units, t.decimals);
          const usd = `$${(t.airdrops.estUsd||0).toFixed(2)}`;
          return `• ${esc(t.symbol||'—')} — ${units}  (${usd})`;
        }).join('\n')
      );
    }
    const txt = lines.length ? lines.join('\n') : 'No airdrops recorded.';
    return { text: [hdr, txt].join('\n'), extra: viewButtons(data.wallet, window, 'airdrops') };
  }

  // overview
  const top = renderTopSection(pos, neg, 3, 3);
  return { text: [hdr, top].join('\n'), extra: viewButtons(data.wallet, window, 'overview') };
}
