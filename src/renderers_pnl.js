// src/renderers_pnl.js
import { esc, money } from './ui_html.js';

const shortAddr = (a) => a ? (a.slice(0,6) + '…' + a.slice(-4)) : '';

/* ----- formatters ----- */
const n4 = (x) => (Number(x)||0).toFixed(4);
const fmtETH = (x) => `${n4(x)} ETH`;

function signETH(val){
  const v = Number(val)||0;
  const body = `${v>=0?'+':'−'}${n4(Math.abs(v))} ETH`;
  if (v > 0)  return `🟢 <b>${esc(body)}</b>`;
  if (v < 0)  return `🔴 <b>${esc(body)}</b>`;
  return `⚪️ <b>${esc(body)}</b>`;
}
function pctStr(val){
  const v = Number(val)||0;
  const body = `${v>=0?'+':''}${v.toFixed(2)}%`;
  if (v > 0)  return `🟢 <b>${esc(body)}</b>`;
  if (v < 0)  return `🔴 <b>${esc(body)}</b>`;
  return `⚪️ <b>${esc(body)}</b>`;
}
function abbrevUnits(unitsStr, decimals){
  const units = BigInt(unitsStr || '0');
  const scale = 10n ** BigInt(decimals||18);
  const whole = Number(units) / Number(scale || 1n);
  const abs = Math.abs(whole);
  const s = (n) => n.toFixed(2);
  if (abs >= 1_000_000_000) return s(whole/1_000_000_000) + 'b';
  if (abs >= 1_000_000)     return s(whole/1_000_000) + 'm';
  if (abs >= 10_000)        return s(whole/10_000) + 'k';
  return whole.toFixed(2);
}

/* ----- Keyboard ----- */
function kb(wallet, window, view='overview'){
  const windows = ['24h','7d','30d','90d','all'];
  return {
    inline_keyboard: [
      windows.map(w => ({
        text: w === window ? `· ${w} ·` : w,
        callback_data: `pnlv:${wallet}:${w}:${view}`
      })),
      [
        { text:'🏠 Home',     callback_data:`pnlv:${wallet}:${window}:overview` },
        { text:'🟢 Profits',  callback_data:`pnlv:${wallet}:${window}:profits` },
        { text:'🔴 Losses',   callback_data:`pnlv:${wallet}:${window}:losses` },
      ],
      [
        { text:'📦 Open',     callback_data:`pnlv:${wallet}:${window}:open` },
        { text:'🎁 Airdrops', callback_data:`pnlv:${wallet}:${window}:airdrops` },
        { text:'↻ Refresh',   callback_data:`pnl_refresh:${wallet}:${window}` }
      ]
    ]
  };
}

/* ----- Main renderer ----- */
export function renderPNL(data, window='30d', view='overview'){
  const w = String(data.wallet||'').toLowerCase();
  const t = data.totals || {};
  const d = data.derived || {};
  const tokens = Array.isArray(data.tokens) ? data.tokens : [];

  if (view === 'profits')  return renderPnLList(w, window, d.best,  true);
  if (view === 'losses')   return renderPnLList(w, window, d.worst, false);
  if (view === 'open')     return renderOpen(w, window, d.open||[]);
  if (view === 'airdrops') return renderAirdrops(w, window, tokens);

  const lines = [];
  lines.push(`💼 <b>Wallet PnL — ${esc(shortAddr(w))}</b>`);
  lines.push(`<i>Window: ${esc(window)}</i>`);
  lines.push(`💰 <b>Wallet Balance:</b> ${n4(t.ethBalance||0)} ETH`);
  lines.push('');

  lines.push(`💧 <b>ETH IN:</b> ${n4(t.baseIn||0)} ETH`);
  lines.push(`🔥 <b>ETH OUT:</b> ${n4(t.baseOut||0)} ETH`);
  lines.push(`📈 <b>Realized:</b> ${n4(t.realizedBase||0)} ETH`);
  lines.push(`📊 <b>Unrealized:</b> ${n4(t.unrealizedBase||0)} ETH`);
  lines.push(`📦 <b>Holdings:</b> ${esc(money(Number(t.holdingsUsd)||0))}`);
  lines.push(`🎁 <b>Airdrops:</b> ${esc(money(Number(t.airdropsUsd)||0))}`);

  const pnl = Number(t.totalPnlBase)||0;
  const badge = pnl>0 ? '🟢' : pnl<0 ? '🔴' : '⚪️';
  lines.push(`${badge} <b>Total PnL:</b> ${n4(pnl)} ETH  (${pctStr(t.pnlPct)})`);
  lines.push('');

  // Top 3 on home
  lines.push('<b>Top Profits (realized)</b>');
  const best = (d.best||[]).slice(0,3);
  if (!best.length) lines.push('<i>No items</i>');
  else for (const r of best) lines.push(`• ${esc(r.symbol||r.token.slice(0,6))} ${signETH(r.realizedBase)}`);

  lines.push('');
  lines.push('<b>Top Losses (realized)</b>');
  const worst = (d.worst||[]).slice(0,3);
  if (!worst.length) lines.push('<i>No items</i>');
  else for (const r of worst) lines.push(`• ${esc(r.symbol||r.token.slice(0,6))} ${signETH(r.realizedBase)}`);

  return { text: lines.join('\n'), extra: { reply_markup: kb(w, window, 'overview') } };
}

/* ----- Profits/Losses (closed only; already filtered in worker) ----- */
function renderPnLList(wallet, window, rows, isProfit){
  const title = isProfit ? 'Top Profits (realized)' : 'Top Losses (realized)';
  const lines = [];
  lines.push(`<b>${esc(title)}</b>`);
  if (!rows || !rows.length) {
    lines.push('<i>No items</i>');
  } else {
    for (const r of rows){
      const sym  = esc(r.symbol || r.token.slice(0,6));
      const buy  = Number(r.totalBuyBase)||0;
      const sell = Number(r.totalSellBase)||0;
      const pnl  = Number(r.realizedBase)||0;
      const pct  = buy>0 ? (pnl/buy)*100 : 0;
      const dust = BigInt(r.remaining||'0') > 0n ? 'closed (dust left)' : 'closed';
      lines.push(
        `• <b>${sym}</b> — ${signETH(pnl)} (${pctStr(pct)})\n` +
        `   buy ${fmtETH(buy)} · sell ${fmtETH(sell)} · ${esc(dust)}`
      );
    }
  }
  return { text: lines.join('\n'), extra: { reply_markup: kb(wallet, window, isProfit?'profits':'losses') } };
}

/* ----- Open positions ----- */
function renderOpen(wallet, window, rows){
  const lines = [];
  lines.push('<b>Open Positions</b>');
  if (!rows || !rows.length){
    lines.push('<i>No open positions</i>');
  } else {
    for (const r of rows){
      const sym = esc(r.symbol || r.token.slice(0,6));
      const rem = abbrevUnits(r.remaining, r.decimals);
      const buy = Number(r.totalBuyBase)||0;
      const sell= Number(r.totalSellBase)||0;
      const u   = Number(r.unrealizedBase)||0;
      const usd = Number(r.usdValueRemaining)||0;
      lines.push(
        `• <b>${sym}</b>\n` +
        `   ${rem} · MTM ${signETH(u)} · ${esc(money(usd))}\n` +
        `   buy ${fmtETH(buy)} · sell ${fmtETH(sell)}`
      );
    }
  }
  return { text: lines.join('\n'), extra: { reply_markup: kb(wallet, window, 'open') } };
}

/* ----- Airdrops (simple) ----- */
function renderAirdrops(wallet, window, tokens){
  const rows = (tokens||[]).filter(r => (r.airdrops?.count||0) > 0);
  const lines = [];
  lines.push('<b>Airdrops</b>');
  if (!rows.length){
    lines.push('<i>No airdrops</i>');
  } else {
    for (const r of rows){
      const sym = esc(r.symbol || r.token.slice(0,6));
      lines.push(`• <b>${sym}</b>`);
    }
  }
  return { text: lines.join('\n'), extra: { reply_markup: kb(wallet, window, 'airdrops') } };
}