// src/holdersIndex.js
import axios from 'axios';
import { withLock, getJSON, setJSON } from './cache.js';

const ALCHEMY_URL = process.env.ALCHEMY_URL; // e.g. https://abstract-mainnet.g.alchemy.com/v2/xxx
if (!ALCHEMY_URL) {
  console.warn('[holdersIndex] ALCHEMY_URL not set – set env ALCHEMY_URL');
}

// ---- JSON-RPC helper ----
async function rpc(method, params) {
  const { data } = await axios.post(ALCHEMY_URL, { id: 1, jsonrpc: '2.0', method, params }, { timeout: 45000 });
  if (data.error) throw new Error(data.error.message || 'RPC error');
  return data.result;
}

// ---- ERC20 ABI selectors ----
const SELECTOR_TOTAL_SUPPLY = '0x18160ddd'; // totalSupply()
const SELECTOR_DECIMALS     = '0x313ce567'; // decimals()
const TOPIC_TRANSFER        = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer(address,address,uint256)

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dEaD';

// ---- helpers ----
function toHexBlock(n) { return '0x' + BigInt(n).toString(16); }
function toBig(x) { return BigInt(x); }
function strip0x(s='') { return s.startsWith('0x') ? s.slice(2) : s; }
function addrFromTopic(t) { return '0x' + strip0x(t).slice(26*2); } // last 20 bytes
function fromHexQuantity(q) { return Number(BigInt(q)); }

// Decode uint256 from log data (32-byte)
function decodeUint256(data) {
  const hex = strip0x(data);
  return BigInt('0x' + hex.slice(-64));
}

// ---- contract calls ----
async function erc20TotalSupply(token) {
  const res = await rpc('eth_call', [{ to: token, data: SELECTOR_TOTAL_SUPPLY }, 'latest']);
  return toBig(res || '0x0');
}

async function erc20Decimals(token) {
  try {
    const res = await rpc('eth_call', [{ to: token, data: SELECTOR_DECIMALS }, 'latest']);
    return Number(BigInt(res || '0x12')); // default 18 if fail below
  } catch {
    return 18;
  }
}

// ---- log streaming in chunks (reliable & rate friendly) ----
async function getLogsPaged({ token, fromBlock = 0, toBlock = 'latest', step = 50000 }) {
  // Find numeric toBlock
  let latestBlock = toBlock;
  if (toBlock === 'latest') {
    const bnHex = await rpc('eth_blockNumber', []);
    latestBlock = fromHexQuantity(bnHex);
  }
  const out = [];
  let start = fromBlock;
  while (start <= latestBlock) {
    const end = Math.min(latestBlock, start + step);
    const logs = await rpc('eth_getLogs', [{
      fromBlock: toHexBlock(start),
      toBlock: toHexBlock(end),
      address: token,
      topics: [TOPIC_TRANSFER]
    }]);
    out.push(...logs);
    start = end + 1;
  }
  return out;
}

// ---- main snapshot builder ----
export async function buildHoldersSnapshot(token, { cacheTtlSec = 300 } = {}) {
  token = token.toLowerCase();

  // cache key
  const key = `holders:snapshot:${token}`;
  // Avoid recomputing if cached
  const cached = await getJSON(key);
  if (cached) return cached;

  return withLock(`lock:${key}`, 60, async () => {
    const again = await getJSON(key);
    if (again) return again;

    const [decimals, totalSupply, blockHex] = await Promise.all([
      erc20Decimals(token),
      erc20TotalSupply(token),
      rpc('eth_blockNumber', [])
    ]);
    const latestBlock = fromHexQuantity(blockHex);

    // Rebuild balances from Transfer logs
    const logs = await getLogsPaged({ token, fromBlock: 0, toBlock: latestBlock });
    const balances = new Map(); // address => BigInt

    function addBal(a, delta) {
      const k = a.toLowerCase();
      const cur = balances.get(k) || 0n;
      const nxt = cur + delta;
      if (nxt === 0n) balances.delete(k); else balances.set(k, nxt);
    }

    for (const L of logs) {
      // topics: [Transfer, from, to]; data: value
      const from = addrFromTopic(L.topics[1] || '');
      const to   = addrFromTopic(L.topics[2] || '');
      const val  = decodeUint256(L.data || '0x');

      if (from !== ZERO) addBal(from, -val);
      if (to   !== ZERO) addBal(to,   +val);
    }

    // burn supply
    const burnBal = (balances.get(ZERO) || 0n) + (balances.get(DEAD) || 0n);
    // remove explicit zero address entries if present
    balances.delete(ZERO);
    balances.delete(DEAD);

    // total supply might not equal sum(balances)+burn when mints/burns occurred; we’ll base percent on totalSupply.
    const denom = totalSupply === 0n ? 1n : totalSupply;

    // Convert to list & compute percents
    const holders = [];
    for (const [addr, bal] of balances.entries()) {
      if (bal <= 0n) continue;
      const pct = Number((bal * 10_000_000n) / denom) / 100_000; // 2 decimals precision w/o float drift
      holders.push({ address: addr, balance: bal, percent: pct });
    }
    // sort by balance desc
    holders.sort((a, b) => (b.balance > a.balance ? 1 : (b.balance < a.balance ? -1 : 0)));

    const top20 = holders.slice(0, 20).map(h => ({ address: h.address, percent: h.percent }));
    const top10CombinedPct = top20.slice(0, 10).reduce((s, h) => s + (Number(h.percent) || 0), 0);
    const burnedPct = Number((burnBal * 10_000_000n) / denom) / 100_000;

    // optional “all percents” for richer stats/renderer (compact)
    const holdersAllPerc = holders.map(h => h.percent);

    const snapshot = {
      token,
      decimals,
      totalSupply: totalSupply.toString(),
      latestBlock,
      holdersCount: holders.length,
      holdersTop20: top20,
      top10CombinedPct,
      burnedPct,
      holdersAllPerc
    };

    await setJSON(key, snapshot, cacheTtlSec);
    return snapshot;
  });
}
