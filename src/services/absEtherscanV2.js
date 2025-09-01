// src/services/absEtherscanV2.js
// Etherscan v2 helpers for Abstract (chainid=2741)

const BASE = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const CHAIN_ID = process.env.ETHERSCAN_CHAIN_ID || '2741';
const API_KEY = process.env.ETHERSCAN_API_KEY || process.env.ETHERSCAN_APIKEY || '';

function qs(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

async function esv2(module, action, params = {}) {
  const url = `${BASE}?${qs({
    chainid: CHAIN_ID,
    module,
    action,
    apikey: API_KEY,
    ...params,
  })}`;
  console.log('[ESV2]', url);
  const r = await fetch(url);
  const t = await r.text();
  try {
    const j = JSON.parse(t);
    // v2 returns { status, message, result }
    if (j.status === '1' || j.message === 'OK') return j.result;
    throw new Error(j?.result || j?.message || 'Etherscan v2 error');
  } catch (e) {
    throw new Error(`Etherscan v2 error: ${t}`);
  }
}

/* ---------------- core endpoints ---------------- */

// Transfer logs (topic0 = ERC20 Transfer)
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export async function getTransferLogsPage(address, page = 1, offset = 1000) {
  return esv2('logs', 'getLogs', {
    address,
    topic0: TRANSFER_TOPIC,
    fromBlock: 0,
    toBlock: 'latest',
    page,
    offset,
  });
}

export async function getAllTransferLogs(address, { maxPages = 25, pageSize = 1000 } = {}) {
  const all = [];
  for (let p = 1; p <= maxPages; p++) {
    const batch = await getTransferLogsPage(address, p, pageSize);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < pageSize) break;
  }
  return all;
}

export async function getContractCreation(address) {
  const res = await esv2('contract', 'getcontractcreation', {
    contractaddresses: address,
  });
  // v2 returns array like [{ contractAddress, contractCreator, txHash }]
  const row = Array.isArray(res) ? res[0] : null;
  return {
    contractAddress: address.toLowerCase(),
    creatorAddress: (row?.contractCreator || row?.creatorAddress || '').toLowerCase() || null,
    txHash: row?.txHash || null,
  };
}

// Always use stats.tokensupply which returns a full integer string (no scientific notation)
export async function getTokenTotalSupply(address) {
  const res = await esv2('stats', 'tokensupply', { contractaddress: address });
  // result is a decimal string
  if (typeof res !== 'string') throw new Error('tokensupply: unexpected result');
  return res;
}

/* ---------------- decoding + compute ---------------- */

function topicAddr(t) {
  // topics are 0x + 64 hex; right-most 40 belong to the addr
  if (typeof t !== 'string' || t.length < 66) return null;
  return ('0x' + t.slice(26)).toLowerCase();
}
function hexToBigInt(h) {
  if (!h || h === '0x') return 0n;
  return BigInt(h);
}

// Build balances map from Transfer logs (mint/burn supported)
export function buildBalanceMapFromLogs(logs) {
  const balances = new Map(); // address -> BigInt
  for (const L of logs) {
    const from = topicAddr(L.topics?.[1]);
    const to = topicAddr(L.topics?.[2]);
    const value = hexToBigInt(L.data);

    if (from && value) {
      balances.set(from, (balances.get(from) || 0n) - value);
    }
    if (to && value) {
      balances.set(to, (balances.get(to) || 0n) + value);
    }
  }
  return { balances, decimals: 18 }; // decimals best-effort (on-chain read avoided)
}

const NULL_ADDR = '0x0000000000000000000000000000000000000000';
const DEAD_ADDR = '0x000000000000000000000000000000000000dead';

function isBurn(a) {
  if (!a) return false;
  const x = a.toLowerCase();
  return x === NULL_ADDR || x === DEAD_ADDR;
}

export function summarizeHoldersFromBalances(
  balances,
  totalSupplyStr,
  { exclude = [] } = {}
) {
  const tot = BigInt(totalSupplyStr);
  const skip = new Set([...exclude.map((a) => a?.toLowerCase()).filter(Boolean), NULL_ADDR, DEAD_ADDR]);

  const entries = [];
  let burned = 0n;

  for (const [addr, bal] of balances.entries()) {
    if (bal <= 0n) continue;
    if (isBurn(addr)) {
      burned += bal;
      continue;
    }
    if (skip.has(addr.toLowerCase())) continue;
    entries.push([addr, bal]);
  }

  entries.sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  const top20 = entries.slice(0, 20).map(([address, bal]) => ({
    address,
    percent: tot > 0n ? Number((bal * 1000000n) / tot) / 10000 : 0, // two decimals
  }));

  const top10CombinedPct = entries
    .slice(0, 10)
    .reduce((acc, [, bal]) => acc + (tot > 0n ? Number((bal * 1000000n) / tot) / 10000 : 0), 0);

  const burnedPct = tot > 0n ? Number((burned * 1000000n) / tot) / 10000 : 0;

  return {
    holdersTop20: top20,
    top10CombinedPct,
    burnedPct,
    holdersCount: entries.length, // after skipping zeros/burn/pair(s)
  };
}

// First 20 buyers: creator first, then first 19 unique recipients (excluding pair & burn)
export function first20BuyersStatus({ logs, balances, creator, pair }) {
  const pairSet = new Set((Array.isArray(pair) ? pair : [pair]).filter(Boolean).map((x) => x.toLowerCase()));
  const uniq = [];
  const firstRecv = new Map(); // addr -> BigInt initial received

  // logs come back time-ordered asc from our fetch; if not, sort by blockNumber/logIndex
  const sorted = [...logs].sort((a, b) => {
    const bn = (x) => Number(x.blockNumber || x.blocknumber || 0);
    const li = (x) => Number(x.logIndex || x.logindex || 0);
    return bn(a) - bn(b) || li(a) - li(b);
  });

  // Seed with creator first
  if (creator) uniq.push(creator.toLowerCase());

  for (const L of sorted) {
    const to = topicAddr(L.topics?.[2]);
    if (!to || isBurn(to) || pairSet.has(to.toLowerCase())) continue;
    if (!uniq.includes(to.toLowerCase())) {
      uniq.push(to.toLowerCase());
      // initial received in this event
      firstRecv.set(to.toLowerCase(), hexToBigInt(L.data));
    }
    if (uniq.length >= 20) break;
  }

  const list = uniq.slice(0, 20).map((addr) => {
    const initial = firstRecv.get(addr) || 0n;
    const current = balances.get(addr) || 0n;

    let status = 'hold';
    if (current === 0n) status = 'sold';
    else if (current > initial) status = 'bought more';
    else if (current < initial) status = 'sold some';

    return { address: addr, status };
  });

  return list;
}
