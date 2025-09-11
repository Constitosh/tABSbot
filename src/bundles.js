// src/bundles.js
// Bundle detector for "first buyers" on Abstract.
// Heuristic: wallets are in a bundle if their first buy was funded by the same funder
// in a short window before the buy.

// Types expected from refreshWorker:
// firstBuys: [{ address, ts, blockNumber, firstBuyAmtRaw (bigint), decimals, percentOfSupply }]
// fundingMap: Map<buyerAddr, { funder: string, fundTxHash: string, ts: number, blockNumber: number, amountWei: bigint }>

const toPct = (x) => (Math.round(Number(x) * 10000) / 100).toFixed(2); // 0.00..100.00
const shortAddr = (a) => (a ? (a.slice(0,6) + '…' + a.slice(-4)) : 'unknown');

export function detectBundles(firstBuys, fundingMap, {
  // must be funded no later than this many blocks *before* the first buy
  maxBlocksBeforeBuy = 200,
  // group label: funder address
} = {}) {
  if (!Array.isArray(firstBuys) || firstBuys.length === 0) {
    return { groups: [], totals: { buyers: 0, bundledWallets: 0, uniqueFunders: 0, supplyPct: 0 } };
  }

  // Build groups by funder
  const byFunder = new Map(); // funder -> { funder, members: [], supplyPct: number }
  let bundledCount = 0;
  let totalSupplyPct = 0;

  for (const b of firstBuys) {
    const buyer = String(b.address || '').toLowerCase();
    const f = fundingMap.get(buyer);
    if (!f || !f.funder) continue;

    // only accept if funding happened not too far before buy
    const blockGap = (b.blockNumber ?? 0) - (f.blockNumber ?? 0);
    if (!Number.isFinite(blockGap) || blockGap < 0 || blockGap > maxBlocksBeforeBuy) {
      continue;
    }

    const key = String(f.funder).toLowerCase();
    if (!byFunder.has(key)) byFunder.set(key, { funder: key, members: [], supplyPct: 0 });
    const g = byFunder.get(key);

    g.members.push({
      buyer,
      fundTxHash: f.fundTxHash || '',
      fundTs: f.ts || 0,
      fundBlock: f.blockNumber || 0,
      amountWei: f.amountWei || 0n,
      firstBuyAmtRaw: b.firstBuyAmtRaw || 0n,
      decimals: b.decimals || 18,
      percentOfSupply: Number(b.percentOfSupply || 0),
    });
    g.supplyPct += Number(b.percentOfSupply || 0);
    totalSupplyPct += Number(b.percentOfSupply || 0);
    bundledCount++;
  }

  // Flatten/sort
  const groups = [...byFunder.values()]
    .map(g => ({
      funder: g.funder,
      buyers: g.members.length,
      supplyPct: Number(g.supplyPct.toFixed(4)),
      members: g.members.sort((a,b) => a.fundTs - b.fundTs),
    }))
    .filter(g => g.buyers >= 2) // only meaningful bundles
    .sort((a, b) => {
      if (b.buyers !== a.buyers) return b.buyers - a.buyers;
      return b.supplyPct - a.supplyPct;
    });

  return {
    groups,
    totals: {
      buyers: firstBuys.length,
      bundledWallets: bundledCount,
      uniqueFunders: groups.length,
      supplyPct: Number(totalSupplyPct.toFixed(4)),
    }
  };
}

/**
 * Build a simple funding map from external/internal ETH txs:
 *  - funding if "to=buyer" and value>0
 *  - keep the *closest* funding tx BEFORE the buyer's first buy block
 */
export function buildFundingMap(buyers, externalsAsc, internalsAsc) {
  const map = new Map(); // buyer -> { funder, fundTxHash, blockNumber, ts, amountWei }
  if (!Array.isArray(buyers) || buyers.length === 0) return map;

  // Index both lists by recipient (to) for quick scan
  const add = (tx, isInternal = false) => {
    const to = String(tx.to || '').toLowerCase();
    const from = String(tx.from || '').toLowerCase();
    if (!to || !from) return;
    const ts = Number(tx.timeStamp || tx.timestamp || 0);
    const bn = Number(tx.blockNumber || 0);
    const val = BigInt(String(tx.value || '0'));
    if (val <= 0n) return;

    let list = idx.get(to);
    if (!list) idx.set(to, list = []);
    list.push({ from, hash: tx.hash, ts, bn, val, type: isInternal ? 'internal' : 'external' });
  };

  const idx = new Map();
  (externalsAsc || []).forEach(t => add(t, false));
  (internalsAsc || []).forEach(t => add(t, true));

  for (const b of buyers) {
    const buyer = String(b.address || '').toLowerCase();
    const firstBuyBlock = Number(b.blockNumber || 0);
    const arr = idx.get(buyer) || [];
    // choose the latest funding strictly before the first buy block
    let best = null;
    for (const t of arr) {
      if (t.bn >= firstBuyBlock) continue;
      if (!best || t.bn > best.bn) best = t;
    }
    if (best) {
      map.set(buyer, {
        funder: best.from,
        fundTxHash: best.hash,
        blockNumber: best.bn,
        ts: best.ts,
        amountWei: best.val,
      });
    }
  }
  return map;
}