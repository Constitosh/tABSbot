import { shortAddr } from '../util.js';

function summarizeHolders(holders) {
  const top20 = holders.slice(0, 20);
  const top10CombinedPct = top20.slice(0, 10).reduce((sum, h) => sum + h.percent, 0);
  let burnedPct = 0;
  const burnedAddrs = [
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dead'
  ];
  for (let addr of burnedAddrs) {
    const h = holders.find(hh => hh.address === addr);
    if (h) burnedPct += h.percent;
  }
  return { top20, top10CombinedPct, burnedPct };
}

function buildCurrentBalanceMap(holders) {
  const map = new Map();
  for (let h of holders) {
    map.set(h.address, h.quantity);
  }
  return map;
}

function first20BuyersStatus(transfers, currentBalancesMap, contractAddress) {
  const knownContracts = [
    '0x7a250d5630b4cf539739df2c5dacb4c659f2488d',
    '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45'
  ];
  const buyTransfers = transfers.filter(t => 
    t.to !== t.from && 
    t.value > 0n && 
    t.to !== contractAddress.toLowerCase() &&
    !knownContracts.some(kc => kc === t.to)
  );
  const seen = new Set();
  const buyers = [];
  for (let t of buyTransfers) {
    const addr = t.to;
    if (!seen.has(addr)) {
      seen.add(addr);
      const firstReceived = t.value;
      const current = currentBalancesMap.get(addr) || 0n;
      let status;
      if (current === 0n) status = 'SOLD ALL';
      else if (current < firstReceived) status = 'SOLD SOME';
      else if (current === firstReceived) status = 'HOLD';
      else status = 'BOUGHT MORE';
      buyers.push({ address: addr, status });
      if (buyers.length === 20) break;
    }
  }
  return buyers;
}

function renderTop20Holders(top20) {
  return top20.map((h, i) => `${i + 1}. ${shortAddr(h.address)} (${h.percent.toFixed(2)}%)`).join('\n');
}

function renderFirst20Buyers(buyers) {
  return buyers.map((b, i) => `${i + 1}. ${shortAddr(b.address)} - ${b.status}`).join('\n');
}

export { 
  summarizeHolders, 
  buildCurrentBalanceMap, 
  first20BuyersStatus, 
  renderTop20Holders, 
  renderFirst20Buyers 
};
