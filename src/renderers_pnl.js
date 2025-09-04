// src/renderers_pnl.js

const wins = ['24h','7d','30d','90d','all'];
const views = [
  { key:'overview', label:'🏠 Home' },
  { key:'profits',  label:'🟢 Profits' },
  { key:'losses',   label:'🔴 Losses' },
  { key:'open',     label:'📦 Open' },
  { key:'airdrops', label:'🎁 Airdrops' },
];

const fmt4 = (n)=> (Math.round(Number(n||0)*1e4)/1e4).toFixed(4);
const fmtUsd = (n)=> `$${Number(n||0).toLocaleString(undefined,{maximumFractionDigits:2})}`;
const esc = (s='')=> String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function keyboard(wallet, window, view){
  const rows=[];
  rows.push(wins.map(w=>({ text: w===window?`· ${w} ·`:w, callback_data:`pnlv:${wallet}:${w}:${view}`})));
  const r1=[], r2=[];
  for(const v of views) (r1.length<3?r1:r2).push({ text:v.label, callback_data:`pnlv:${wallet}:${window}:${v.key}` });
  rows.push(r1); rows.push(r2);
  rows.push([{text:'↻ Refresh', callback_data:`pnl_refresh:${wallet}:${window}`}]);
  return { inline_keyboard: rows };
}

function realizedLists(data){
  // Build once from tokens to have consistent buys/sells
  const by = new Map();
  for(const t of (data.tokens||[])){
    const sym = t.symbol||''; if(!sym || ['ETH','WETH'].includes(sym.toUpperCase())) continue;
    const r = Number(t.realizedWeth||0);
    if (Math.abs(r) < 1e-10) continue;
    const spent = Number(t.totalBuysEth||0);
    by.set(sym, {
      symbol: sym,
      realized: r,
      pct: spent>0 ? (r/spent)*100 : 0,
      buys: Number(t.totalBuysEth||0),
      sells: Number(t.totalSellsEth||0),
    });
  }
  const vals=[...by.values()];
  const profits = vals.filter(x=>x.realized>0).sort((a,b)=>b.realized-a.realized);
  const losses  = vals.filter(x=>x.realized<0).sort((a,b)=>a.realized-b.realized);
  return { profits, losses };
}

function renderOverview(data, window){
  const w = data.wallet.slice(0,6)+'…'+data.wallet.slice(-4);
  const t = data.totals||{};
  const total = Number(t.totalPnlWeth||0);
  const pct = Number(t.pnlPct||0);
  const dot = total>0?'🟢':(total<0?'🔴':'⚪️');

  const lines = [
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
    `${dot} <b>Total PnL:</b> ${fmt4(total)} ETH  (${total>=0?'🟢':'🔴'} ${fmt4(Math.abs(pct))}%)`,
    ''
  ];

  const {profits, losses} = realizedLists(data);
  const topP = profits.slice(0,3).map(p=>[
    `• ${esc(p.symbol)} — 🟢`,
    `🟢 +${fmt4(p.realized)} ETH (🟢 +${fmt4(p.pct)}%)`,
    `Bought ${fmt4(p.buys)} ETH`,
    `Sold ${fmt4(p.sells)} ETH`,
    ''
  ].join('\n')).join('\n') || 'No items';

  const topL = losses.slice(0,3).map(p=>[
    `• ${esc(p.symbol)} — 🔴`,
    `🔴 −${fmt4(Math.abs(p.realized))} ETH (🔴 -${fmt4(Math.abs(p.pct))}%)`,
    `Bought ${fmt4(p.buys)} ETH`,
    `Sold ${fmt4(p.sells)} ETH`,
    ''
  ].join('\n')).join('\n') || 'No items';

  return lines.join('\n') + `<b>Top Profits (realized)</b>\n${topP}\n<b>Top Losses (realized)</b>\n${topL}`;
}

function renderProfits(data){
  const {profits} = realizedLists(data);
  if(!profits.length) return '<b>Top Profits (realized)</b>\nNo items';
  const out=['<b>Top Profits (realized)</b>',''];
  for(const p of profits){
    out.push(`• ${esc(p.symbol)} — 🟢`);
    out.push(`🟢 +${fmt4(p.realized)} ETH (🟢 +${fmt4(p.pct)}%)`);
    out.push(`Bought ${fmt4(p.buys)} ETH`);
    out.push(`Sold ${fmt4(p.sells)} ETH`);
    out.push('');
  }
  return out.join('\n');
}
function renderLosses(data){
  const {losses} = realizedLists(data);
  if(!losses.length) return '<b>Top Losses (realized)</b>\nNo items';
  const out=['<b>Top Losses (realized)</b>',''];
  for(const p of losses){
    out.push(`• ${esc(p.symbol)} — 🔴`);
    out.push(`🔴 −${fmt4(Math.abs(p.realized))} ETH (🔴 -${fmt4(Math.abs(p.pct))}%)`);
    out.push(`Bought ${fmt4(p.buys)} ETH`);
    out.push(`Sold ${fmt4(p.sells)} ETH`);
    out.push('');
  }
  return out.join('\n');
}
function humanQty(unitsStr,decimals){
  try{
    const q=BigInt(unitsStr||'0'); const scale=10n**BigInt(decimals||18);
    const n=Number(q)/Number(scale||1n);
    if (n<10000) return n.toLocaleString(undefined,{maximumFractionDigits:4});
    const k=n/1e3; if(k<1000) return `${(Math.round(k*100)/100).toLocaleString(undefined,{maximumFractionDigits:2})}k`;
    const m=n/1e6; return `${(Math.round(m*100)/100).toLocaleString(undefined,{maximumFractionDigits:2})}m`;
  }catch{ return '0'; }
}
function renderOpen(data){
  const items=data.derived?.open||[];
  if(!items.length) return '<b>Open Positions</b>\nNo items';
  const out=['<b>Open Positions</b>',''];
  for(const t of items){
    out.push(`• ${esc(t.symbol)} — ${fmtUsd(t.usdValueRemaining||0)}`);
    out.push(`Holdings: ${humanQty(t.remaining, t.decimals)}`);
    out.push('');
  }
  return out.join('\n');
}
function renderAirdrops(data){
  const tokenDrops = (data.derived?.airdrops||[]);
  const nftDrops   = (data.derived?.nftAirdrops||[]);
  const out=['<b>Airdrops</b>',''];
  if(!tokenDrops.length && !nftDrops.length) return out.join('\n')+'No items';

  if (tokenDrops.length){
    out.push('<i>Tokens</i>');
    for(const d of tokenDrops) out.push(`• ${esc(d.symbol)} — est ${fmtUsd(d.estUsd||0)}`);
    out.push('');
  }
  if (nftDrops.length){
    out.push('<i>NFTs</i>');
    for(const n of nftDrops) out.push(`• ${esc(n.name)} — qty ${n.qty}`);
  }
  return out.join('\n');
}

export function renderPNL(data, window='30d', view='overview'){
  const wallet = String(data.wallet).toLowerCase();
  let text='';
  switch(view){
    case 'profits': text = renderProfits(data); break;
    case 'losses':  text = renderLosses(data);  break;
    case 'open':    text = renderOpen(data);    break;
    case 'airdrops':text = renderAirdrops(data);break;
    default:        text = renderOverview(data, window);
  }
  return {
    text,
    extra: {
      parse_mode:'HTML',
      disable_web_page_preview:true,
      reply_markup: keyboard(wallet, window, view)
    }
  };
}