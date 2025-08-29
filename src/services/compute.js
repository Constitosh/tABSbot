import { shortAddr } from '../util.js';

// Normalize holder list into % and detect burns
export function summarizeHolders(holders) {
  const top20 = holders.slice(0, 20).map(h => ({
    address: h.TokenHolderAddress,
    quantity: h.TokenHolderQuantity,
    percent: Number(h.Percentage || 0)
  }));

  const top10Pct = top20.slice(0, 10).reduce((a,b)=>a + (b.percent||0), 0);

  const burnAddrs = new Set([
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dead'
  ]);
  const burnedPct = top20
    .filter(h => burnAddrs.has(h.address.toLowerCase()))
    .reduce((a,b)=> a + (b.percent||0), 0);

  return { top20, top10Pct, burnedPct };
}

// First 20 buyers + status
export function first20BuyersStatus(transfersAsc, currentBalancesMap) {
  // transfersAsc: Etherscan tokentx ascending, fields: from, to, value (raw units), tokenDecimal
  const buyers = [];
  const seen = new Set();

  for (const tx of transfersAsc) {
    const to = (tx.to || '').toLowerCase();
    const from = (tx.from || '').toLowerCase();
    if (!to || to === '0x0000000000000000000000000000000000000000') continue;

    // Heuristic: skip deployer/contract itself and routers if desired (out of scope for now)
    if (seen.has(to)) continue;
    if (to === (tx.contractAddress||'').toLowerCase()) continue;

    // first time "receiving" tokens = considered initial buyer
    seen.add(to);
    const decimals = Number(tx.tokenDecimal || 18);
    const received = Number(tx.value) / (10 ** decimals);
    buyers.push({ address: to, firstReceived: received });
    if (buyers.length >= 20) break;
  }

  // Compute status vs current balance
  return buyers.map(b => {
    const cur = currentBalancesMap.get(b.address) || 0;
    let status = 'HOLD';
    if (cur === 0) status = 'SOLD ALL';
    else if (cur < b.firstReceived) status = 'SOLD SOME';
    else if (cur > b.firstReceived) status = 'BOUGHT MORE';
    else status = 'HOLD';
    return { ...b, current: cur, status };
  });
}

// Build a quick map address->percent and ->balance (if quantity available)
export function buildCurrentBalanceMap(holders) {
  const map = new Map();
  for (const h of holders) {
    // We only know percentage reliably; quantity is raw token units; if not available, treat percent as proxy.
    const quantity = Number(h.TokenHolderQuantity || 0);
    map.set(h.TokenHolderAddress.toLowerCase(), quantity);
  }
  return map;
}

export function renderTop20Holders(top20) {
  return top20.map((h,i)=>`${String(i+1).padStart(2,'0')}. ${shortAddr(h.address)} — ${h.percent.toFixed(2)}%`).join('\n');
}

export function renderFirst20Buyers(rows) {
  return rows.map((r,i)=>`${String(i+1).padStart(2,'0')}. ${shortAddr(r.address)} — ${r.status}`).join('\n');
}
