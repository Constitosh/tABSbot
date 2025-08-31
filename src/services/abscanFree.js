// src/services/abscanFree.js
// Abscan (Abstract) free endpoints with Etherscan-compatible shapes.
// Requires ABSCAN_API in .env (e.g. https://api.abscan.org/api)
import '../configEnv.js';
import axios from 'axios';

const BASE = (process.env.ABSCAN_API || 'https://api.abscan.org/api').replace(/\/+$/, '');
const KEY  = process.env.ABSCAN_API_KEY || '';

const qs = (o) =>
  Object.entries(o)
    .filter(([,v]) => v !== undefined && v !== null && v !== '')
    .map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

async function call(params, { timeout = 15000 } = {}) {
  const url = `${BASE}?${qs({ ...params, apikey: KEY || undefined })}`;
  const { data } = await axios.get(url, { timeout });
  if (!data) throw new Error('Abscan: empty');
  if (data.status === '0' && /rate limit|NOTOK/i.test(`${data.message} ${data.result}`)) {
    throw new Error('Abscan: rate limited');
  }
  // Some explorers return `{status,message,result}`; others return the array directly
  return data.result ?? data;
}

/* ---------------- supply & balances ---------------- */

export async function getTokenTotalSupply(contractAddress) {
  const res = await call({ module:'token', action:'tokensupply', contractaddress: contractAddress });
  const n = Number(res?.TokenSupply ?? res?.result ?? res);
  return Number.isFinite(n) ? n : 0;
}

export async function getTokenBalance(contractAddress, holder) {
  const res = await call({
    module: 'account',
    action: 'tokenbalance',
    contractaddress: contractAddress,
    address: holder,
    tag: 'latest'
  });
  const n = Number(res?.TokenBalance ?? res?.result ?? res);
  return Number.isFinite(n) ? n : 0;
}

/* ---------------- transfers (ascending) ---------------- */

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
  const list = Array.isArray(res) ? res : (res?.result || []);
  return list.map(t => ({
    blockNumber: Number(t.blockNumber),
    timeStamp: Number(t.timeStamp),
    hash: t.hash,
    from: String(t.from || '').toLowerCase(),
    to: String(t.to || '').toLowerCase(),
    value: String(t.value ?? '0'),
    tokenDecimal: Number(t.tokenDecimal || t.decimals || 18)
  }));
}

/* ---------------- creator (deployer) ---------------- */

export async function getContractCreator(contractAddress) {
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

export function computeFirst20BuyersSeed(transfersAsc) {
  const first = new Map(); // addr -> { amountRaw, decimals }
  for (const t of transfersAsc) {
    const recv = t.to;
    if (!recv || recv === '0x0000000000000000000000000000000000000000') continue;
    if (!first.has(recv)) {
      first.set(recv, { amountRaw: String(t.value || '0'), decimals: t.tokenDecimal || 18 });
      if (first.size >= 20) break;
    }
  }
  return first;
}

export function statusFromBalance(startRaw, dec, currentRaw) {
  const toNum = (raw, d) => Number(raw) / Math.pow(10, d || 18);
  const start = toNum(startRaw, dec);
  const curr  = toNum(currentRaw, dec);
  if (start <= 0) return 'UNKNOWN';
  if (curr === 0) return 'SOLD ALL';
  if (curr > start) return 'BOUGHT MORE';
  if (curr < start) return 'SOLD SOME';
  return 'HOLD';
}
