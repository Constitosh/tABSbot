// src/services/etherscanFree.js
// Free Etherscan API helpers (no Pro features).
// Requires: ETHERSCAN_API_KEY in .env
import '../configEnv.js';
import axios from 'axios';

const KEY  = process.env.ETHERSCAN_API_KEY || '';
const BASE = process.env.ETHERSCAN_V2_BASE?.replace(/\/+$/, '') || 'https://api.etherscan.io/v2/api';

// tiny qs
const qs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

async function call(params, { timeout = 15000 } = {}) {
  const url = `${BASE}?${qs({ ...params, apikey: KEY })}`;
  const { data } = await axios.get(url, { timeout });
  if (!data) throw new Error('Etherscan: empty');
  if (data.status === '0' && /rate limit|NOTOK/i.test(`${data.message} ${data.result}`)) {
    throw new Error('Etherscan: rate limited');
  }
  return data.result ?? data;
}

/* ---------------- supply & balances ---------------- */

export async function getTokenTotalSupply(contractAddress) {
  // v2 => module=token, action=tokensupply
  const result = await call({
    module: 'token',
    action: 'tokensupply',
    contractaddress: contractAddress
  });
  const n = Number(result?.TokenSupply ?? result?.result ?? result);
  return Number.isFinite(n) ? n : 0;
}

export async function getTokenBalance(contractAddress, holder) {
  const result = await call({
    module: 'account',
    action: 'tokenbalance',
    contractaddress: contractAddress,
    address: holder,
    tag: 'latest'
  });
  const n = Number(result?.TokenBalance ?? result?.result ?? result);
  return Number.isFinite(n) ? n : 0;
}

export async function getTokenBalancesMulti(contractAddress, addresses = []) {
  // Free Etherscan has balancemulti but for Ether; there’s no official token balancemulti free.
  // We’ll just do sequential tokenbalance calls; keep list small.
  const out = {};
  for (const a of addresses) {
    out[a.toLowerCase()] = await getTokenBalance(contractAddress, a);
  }
  return out;
}

/* ---------------- transfers ---------------- */

export async function getTokenTransfers(contractAddress, startblock = 0, endblock = 999999999, page = 1, offset = 1000) {
  const res = await call({
    module: 'account',
    action: 'tokentx',
    contractaddress: contractAddress,
    page,
    offset,
    startblock,
    endblock,
    sort: 'asc'
  });
  const list = Array.isArray(res) ? res : res?.result || [];
  return list.map(t => ({
    blockNumber: Number(t.blockNumber),
    timeStamp: Number(t.timeStamp),
    hash: t.hash,
    from: String(t.from || '').toLowerCase(),
    to: String(t.to || '').toLowerCase(),
    value: t.value,             // raw (string)
    tokenDecimal: Number(t.tokenDecimal || t.decimals || 18)
  }));
}

/* ---------------- creator (deployer) ---------------- */

export async function getContractCreator(contractAddress) {
  // Etherscan supports:
  // module=contract&action=getcontractcreation&contractaddresses=<ca>
  const res = await call({
    module: 'contract',
    action: 'getcontractcreation',
    contractaddresses: contractAddress
  });
  const row = Array.isArray(res) ? res[0] : res;
  return {
    contractAddress: row?.contractAddress || contractAddress,
    creatorAddress: (row?.contractCreator || row?.creator || '').toLowerCase() || null,
    txHash: row?.txHash || row?.transactionHash || null
  };
}

/* ---------------- compute helpers (buyers/status) ---------------- */

export function computeFirst20BuyersStatus(transfersAsc) {
  // For ERC-20s, “buy” ~= first time address appears as 'to' receiving tokens from someone that isn't 0x0.
  // We record the first 20 unique receivers.
  const firstSeenReceive = new Map(); // addr -> { amountRaw, decimals }
  for (const t of transfersAsc) {
    const recv = t.to;
    if (!recv || recv === '0x0000000000000000000000000000000000000000') continue;
    if (!firstSeenReceive.has(recv)) {
      firstSeenReceive.set(recv, { amountRaw: t.value, decimals: t.tokenDecimal });
      if (firstSeenReceive.size >= 20) break;
    }
  }

  // Build current balances for those addresses via per-address tokenbalance calls
  const buyers = Array.from(firstSeenReceive.keys());
  return { buyers, seeds: firstSeenReceive };
}

export function statusFromBalance(startRaw, dec, currentRaw) {
  // Compare current vs first received
  const toNum = (raw, d) => Number(raw) / Math.pow(10, d || 18);
  const start = toNum(startRaw, dec);
  const curr  = toNum(currentRaw, dec);
  if (start <= 0) return 'UNKNOWN';
  if (curr === 0) return 'SOLD ALL';
  if (curr > start) return 'BOUGHT MORE';
  if (curr < start) return 'SOLD SOME';
  return 'HOLD';
}
