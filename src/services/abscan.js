// src/services/abscan.js
// Abscan (Abstract) explorer — Etherscan-style API client (robust)
// Reads base from env: ABSCAN_API (default https://abscan.org/api)
// Optional: ABSCAN_API_KEY
import axios from 'axios';
import '../configEnv.js'; // ensure .env is loaded before we read process.env
// ...rest of file

// src/services/abscan.js
// Thin Etherscan v2 client used across the app. No side effects on import.

const ETHERSCAN_BASE =
  process.env.ETHERSCAN_BASE?.trim() || 'https://api.etherscan.io/v2/api';
const ETHERSCAN_CHAIN_ID =
  (process.env.ETHERSCAN_CHAIN_ID || '2741').trim(); // Abstract = 2741
const ETHERSCAN_API_KEY =
  (process.env.ETHERSCAN_API_KEY || process.env.ETHERSCAN_KEY || '').trim();

function buildUrl(module, action, params = {}) {
  const u = new URL(ETHERSCAN_BASE);
  u.searchParams.set('chainid', ETHERSCAN_CHAIN_ID);
  if (ETHERSCAN_API_KEY) u.searchParams.set('apikey', ETHERSCAN_API_KEY);
  u.searchParams.set('module', module);
  u.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

async function getJSON(url) {
  const res = await fetch(url, { method: 'GET' });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); }
  catch { throw new Error(`[ESV2] Non-JSON response: ${text.slice(0, 160)}`); }

  // Etherscan v2 returns { status, message, result }
  if (j?.status === '0' && j?.message) {
    throw new Error(`[ESV2] ${j.message}`);
  }
  return j?.result ?? j;
}

// ---------------- Public helpers ----------------

// Transfers (ERC-20 token tx list)
export async function getTokenTransfers(contractAddress, { page = 1, offset = 1000 } = {}) {
  const url = buildUrl('account', 'tokentx', {
    contractaddress: contractAddress,
    page, offset, startblock: 0, endblock: 999999999, sort: 'asc',
  });
  return getJSON(url);
}

// Contract creator
export async function getContractCreator(contractAddress) {
  const url = buildUrl('contract', 'getcontractcreation', {
    contractaddresses: contractAddress,
  });
  const res = await getJSON(url);
  // ESV2 returns array; pick first row’s contractCreator if present
  const row = Array.isArray(res) ? res[0] : res;
  return row?.contractCreator || null;
}

// Total supply
export async function getTokenSupply(contractAddress) {
  const url = buildUrl('stats', 'tokensupply', { contractaddress: contractAddress });
  const r = await getJSON(url);
  return typeof r === 'string' ? r : (r?.result ?? '0');
}

// (Optional) Transfer logs if you prefer to compute holders from logs
export async function getTransferLogs(contractAddress, { page = 1, offset = 1000 } = {}) {
  // topic0 is keccak256("Transfer(address,address,uint256)")
  const url = buildUrl('logs', 'getLogs', {
    address: contractAddress,
    topic0: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    fromBlock: 0,
    toBlock: 'latest',
    page,
    offset,
  });
  return getJSON(url);
}
