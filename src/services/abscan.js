// src/services/abscan.js
// Abscan (Abstract) explorer — Etherscan-style API client (robust)
// Reads base from env: ABSCAN_API (default https://abscan.org/api)
// Optional: ABSCAN_API_KEY
import axios from 'axios';

const BASE = (process.env.ABSCAN_API || 'https://abscan.org/api').replace(/\/+$/, '');
const KEY  = process.env.ABSCAN_API_KEY || null;
const DBG  = /^true$/i.test(process.env.ABSCAN_DEBUG || '');

// build query string
const qs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

async function callApi(params, { timeout = 15000 } = {}) {
  const url = `${BASE}?${qs({ ...params, apikey: KEY || undefined })}`;
  if (DBG) console.log('[ABSCAN] GET', url);
  const { data } = await axios.get(url, { timeout });

  if (!data) throw new Error('Abscan: empty response');

  // Etherscan-like envelopes are common:
  // { status: "1"|"0", message: "OK"|..., result: [...]|... }
  // Some clones just return the array/object directly.
  if (data.status === '0' && String(data.result).match(/Max rate limit/i)) {
    throw new Error('Abscan: rate limited');
  }

  const result = data.result ?? data;
  if (DBG) {
    const preview = Array.isArray(result) ? { len: result.length, first: result[0] } : result;
    console.log('[ABSCAN] RESULT PREVIEW', JSON.stringify(preview)?.slice(0, 800));
  }
  return result;
}

/* ---------------- HOLDERS ---------------- */

/**
 * Try several common holders endpoints and return the first non-empty result.
 * Normalizes to: { holders: [{address,balance,percent}], totalSupply, holderCount }
 */
export async function getTokenHolders(contractAddress, page = 1, offset = 100) {
  // Candidate actions seen across explorer forks
  const candidates = [
    { module: 'token', action: 'tokenholderlist',   args: { sort: 'desc' } },
    { module: 'token', action: 'tokenholders',      args: { sort: 'desc' } },
    { module: 'stats', action: 'tokenholderlist',   args: { sort: 'desc' } },
    { module: 'token', action: 'tokenholderlistv2', args: { sort: 'desc' } },
  ];

  let raw = null;
  for (const c of candidates) {
    try {
      const res = await callApi({
        module: c.module,
        action: c.action,
        contractaddress: contractAddress,
        page,
        offset,
        ...(c.args || {}),
      });

      // Accept if it's a non-empty array (or contains array in common keys)
      const arr =
        (Array.isArray(res) && res) ||
        res?.holders ||
        res?.result ||
        res?.data ||
        res?.items ||
        null;

      if (Array.isArray(arr) && arr.length > 0) {
        raw = { envelope: res, rows: arr, action: `${c.module}.${c.action}` };
        break;
      }

      // Some APIs return { holders:[], holderCount:N } — accept even if rows empty if count > 0
      const holderCount =
        res?.HolderCount ??
        res?.holderCount ??
        res?.total ??
        res?.pagination?.total ??
        0;

      if (Number(holderCount) > 0) {
        raw = { envelope: res, rows: arr || [], action: `${c.module}.${c.action}` };
        break;
      }
    } catch (e) {
      if (DBG) console.warn(`[ABSCAN] ${c.module}.${c.action} failed:`, e.message);
      // try next candidate
    }
  }

  if (!raw) {
    if (DBG) console.warn('[ABSCAN] no holders endpoint yielded data');
    return { holders: [], totalSupply: 0, holderCount: 0 };
  }

  const { envelope, rows } = raw;

  const totalSupply = toNum(
    envelope?.TokenTotalSupply ??
    envelope?.totalSupply ??
    envelope?.supply ??
    // some explorers put totalSupply in the first row or nested
    rows?.[0]?.TokenTotalSupply ??
    rows?.[0]?.totalSupply ??
    0
  );

  let holderCount = toInt(
    envelope?.HolderCount ??
    envelope?.holderCount ??
    envelope?.total ??
    envelope?.pagination?.total ??
    null
  );
  if (!holderCount && Array.isArray(rows)) holderCount = rows.length;

  const holders = (rows || []).map(normalizeHolder(totalSupply));

  return { holders, totalSupply, holderCount };
}

function normalizeHolder(totalSupply) {
  return (r) => {
    const address =
      r.HolderAddress ||
      r.TokenHolderAddress ||
      r.Address ||
      r.address ||
      r.wallet ||
      null;

    const balance = toNum(
      r.TokenHolderQuantity ??
      r.Balance ??
      r.balance ??
      r.Value ??
      r.value ??
      0
    );

    let percent = r.Percentage != null ? toNum(r.Percentage) : null;
    if ((percent == null || !isFinite(percent)) && totalSupply > 0) {
      percent = (balance / totalSupply) * 100;
    }

    return {
      address: address ? String(address).toLowerCase() : null,
      balance,
      percent: toNum(percent),
    };
  };
}

/* ---------------- TRANSFERS ---------------- */

/**
 * Get ERC-20 transfers (ascending). Normalizes minimal fields.
 */
export async function getTokenTransfers(
  contractAddress,
  startblock = 0,
  endblock = 999999999,
  page = 1,
  offset = 1000
) {
  // standard etherscan-style
  const result = await callApi({
    module: 'account',
    action: 'tokentx',
    contractaddress: contractAddress,
    page,
    offset,
    startblock,
    endblock,
    sort: 'asc',
  });

  const list = Array.isArray(result) ? result : (result?.result || []);
  return list.map((t) => ({
    blockNumber: toInt(t.blockNumber ?? t.block_number),
    timeStamp: toInt(t.timeStamp ?? t.timeStampSec ?? t.timeStampMs),
    hash: t.hash,
    from: String(t.from || '').toLowerCase(),
    to: String(t.to || '').toLowerCase(),
    value: t.value,              // raw string in token decimals
    tokenDecimal: toInt(t.tokenDecimal ?? t.decimals),
  }));
}

/* ---------------- CREATOR ---------------- */

/**
 * Contract creator (deployer).
 */
export async function getContractCreator(contractAddress) {
  // typical: module=contract&action=getcontractcreation&contractaddresses=<ca>
  const result = await callApi({
    module: 'contract',
    action: 'getcontractcreation',
    contractaddresses: contractAddress,
  });

  const row = Array.isArray(result) ? result[0] : result;
  return {
    contractAddress: row?.contractAddress || contractAddress,
    creatorAddress: (row?.contractCreator || row?.creator || '').toLowerCase() || null,
    txHash: row?.txHash || row?.transactionHash || null,
  };
}

/* ---------------- utils ---------------- */
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }