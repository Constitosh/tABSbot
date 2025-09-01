// src/etherscan.js (ESM)
import fetch from 'node-fetch';

const BASE = process.env.ETHERSCAN_BASE;
const CHAINID = process.env.ETHERSCAN_CHAIN_ID || '2741';
const APIKEY = process.env.ETHERSCAN_API_KEY;

// ERC-20 Transfer(address,address,uint256)
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEAD_SET = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dEaD',
  '0x000000000000000000000000000000000000dead'
].map(x => x.toLowerCase()));

function url(params) {
  const u = new URL(BASE);
  Object.entries({ chainid: CHAINID, apikey: APIKEY, ...params }).forEach(([k, v]) => u.searchParams.set(k, String(v)));
  return u.toString();
}
async function apiGet(params) {
  const res = await fetch(url(params));
  const j = await res.json();
  if (j.status !== '1') throw new Error(`Etherscan error: ${j?.result || j?.message || 'unknown'}`);
  return j.result;
}
const toBig = (x) => BigInt(x.toString());
const topicToAddr = (t) => ('0x' + t.slice(-40)).toLowerCase();

// --- public fns ---

// who deployed the contract (creator)
export async function getContractCreator(token) {
  const r = await apiGet({ module: 'contract', action: 'getcontractcreation', address: token });
  return Array.isArray(r) && r[0] ? r[0].contractCreator : null;
}

// token balance of an address (via addresstokenbalance on v2)
export async function getAddressTokenBalance(token, address) {
  const r = await apiGet({ module: 'account', action: 'addresstokenbalance', address, page: 1, offset: 100 });
  const row = (Array.isArray(r) ? r : []).find(x => x.contractAddress?.toLowerCase() === token.toLowerCase());
  return row ? { balance: row.balance, decimals: Number(row.tokenDecimal || 18) } : { balance: '0', decimals: 18 };
}

// scan Transfer logs to reconstruct balances + burns
export async function buildHoldersFromLogs(token, { maxPages = 25, offset = 1000 } = {}) {
  const balances = new Map(); // addr -> bigint
  let burned = 0n;
  let page = 1;

  for (; page <= maxPages; page++) {
    const logs = await apiGet({
      module: 'logs', action: 'getLogs', address: token, topic0: TOPIC_TRANSFER,
      fromBlock: 0, toBlock: 'latest', page, offset
    });
    if (!logs.length) break;

    for (const lg of logs) {
      const from = topicToAddr(lg.topics[1]);
      const to   = topicToAddr(lg.topics[2]);
      const val  = toBig(lg.data);

      if (!DEAD_SET.has(from)) balances.set(from, (balances.get(from) || 0n) - val);
      if (!DEAD_SET.has(to))   balances.set(to,   (balances.get(to)   || 0n) + val);
      if (DEAD_SET.has(to)) burned += val;
    }
    if (logs.length < offset) break;
  }

  // clean negative/zero
  const allBalances = [...balances.entries()].filter(([,v]) => v > 0n);
  const holdersCount = allBalances.length;
  allBalances.sort((a,b) => (b[1] > a[1] ? 1 : -1));

  const top20 = allBalances.slice(0, 20).map(([address, balance]) => ({ address, balance: balance.toString() }));
  const totalCirculating = allBalances.reduce((a, [,v]) => a + v, 0n);

  return {
    holdersTop20: top20,
    holdersCount,
    burned: burned.toString(),
    totalCirculating: totalCirculating.toString()
  };
}

// first 20 buyers matrix using the AMM pair address
export async function first20BuyersMatrix(token, pairAddress, { maxPages = 25, offset = 1000 } = {}) {
  const buyers = new Map(); // addr -> { buys, sells, firstBuy }
  let page = 1;
  const pair = pairAddress.toLowerCase();

  for (; page <= maxPages && buyers.size < 20; page++) {
    const logs = await apiGet({
      module: 'logs', action: 'getLogs', address: token, topic0: TOPIC_TRANSFER,
      fromBlock: 0, toBlock: 'latest', page, offset
    });
    if (!logs.length) break;

    for (const lg of logs) {
      const from = topicToAddr(lg.topics[1]);
      const to   = topicToAddr(lg.topics[2]);
      const val  = toBig(lg.data);

      if (from === pair) {
        if (!buyers.has(to)) buyers.set(to, { buys: 0n, sells: 0n, firstBuy: val });
        const rec = buyers.get(to);
        rec.buys += val;
      } else if (to === pair) {
        if (!buyers.has(from)) continue;
        const rec = buyers.get(from);
        rec.sells += val;
      }
      if (buyers.size >= 20) break;
    }
    if (logs.length < offset) break;
  }

  const rows = [];
  for (const [addr, { buys, sells, firstBuy }] of buyers.entries()) {
    let status = 'hold';
    if (sells === 0n && buys > firstBuy) status = 'bought more';
    else if (sells > 0n && sells < buys) status = 'sold some';
    else if (sells >= buys) status = 'sold all';
    rows.push({
      address: addr,
      firstBuy: firstBuy.toString(),
      totalBuys: buys.toString(),
      totalSells: sells.toString(),
      status
    });
  }
  return rows.slice(0, 20);
}
