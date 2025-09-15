// src/holdersIndex.js
import './configEnv.js';
import axios from 'axios';

/* ---------------- Etherscan V2 client (same style as refreshWorker) ---------------- */

const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741'; // Abstract

if (!ES_KEY) console.warn('[INDEX] ETHERSCAN_API_KEY is missing');

const httpES = axios.create({ baseURL: ES_BASE, timeout: 45_000 });

// Throttle (default 5/sec)
const ES_RPS = Math.max(1, Number(process.env.ETHERSCAN_RPS || 5));
const ES_MIN_INTERVAL = Math.ceil(1000 / ES_RPS);
let esLastTs = 0;
let esChain = Promise.resolve();
async function throttleES() {
  await (esChain = esChain.then(async () => {
    const wait = Math.max(0, esLastTs + ES_MIN_INTERVAL - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    esLastTs = Date.now();
  }));
}
function esParams(params) {
  return { params: { chainid: ES_CHAIN, apikey: ES_KEY, ...params } };
}
function esURL(params) {
  const u = new URL(ES_BASE);
  Object.entries({ chainid: ES_CHAIN, apikey: ES_KEY, ...params }).forEach(([k,v]) => u.searchParams.set(k, String(v)));
  return u.toString();
}
async function esGET(params, { tag = '' } = {}) {
  await throttleES();
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { data } = await httpES.get('', esParams(params));
      if (data?.status === '1') return data.result;
      const msg = data?.result || data?.message || 'Unknown Etherscan error';
      if (attempt === maxAttempts) throw new Error(msg);
    } catch (e) {
      // Surface HTTP status & body for 4xx
      const st = e?.response?.status;
      const body = e?.response?.data;
      if (st) {
        console.warn(`[ESV2][${tag}] ${st} ${esURL(params)} :: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
      }
      if (attempt === maxAttempts) throw e;
    }
    await new Promise(r => setTimeout(r, 400 * attempt));
  }
}

/* ---------------- Constants & helpers ---------------- */

const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = new Set([
  ZERO,
  '0x000000000000000000000000000000000000dEaD',
  '0x000000000000000000000000000000000000dead',
].map(s => s.toLowerCase()));

const toBig = (x) => BigInt(String(x));
const topicToAddr = (t) => ('0x' + String(t).slice(-40)).toLowerCase();

/* ---------------- Block helpers (defensive) ---------------- */

async function getCreationBlock(token) {
  // try contract.getcontractcreation, then earliest tokentx
  try {
    const r = await esGET(
      { module: 'contract', action: 'getcontractcreation', contractaddresses: token },
      { tag: 'creatorBlock' }
    );
    const first = Array.isArray(r) ? r[0] : r;
    const n = Number(first?.blockNumber || first?.blocknumber || first);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  try {
    const r = await esGET(
      { module: 'account', action: 'tokentx', contractaddress: token, page: 1, offset: 1, sort: 'asc' },
      { tag: 'firstTokentx' }
    );
    const n = Number((Array.isArray(r) && r[0]?.blockNumber) || r?.blockNumber);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  return 0; // unknown
}
async function getLatestBlock() {
  try {
    const ts = Math.floor(Date.now() / 1000);
    const r = await esGET(
      { module: 'block', action: 'getblocknobytime', timestamp: ts, closest: 'before' },
      { tag: 'latestBlock' }
    );
    const n = Number(r?.blockNumber || r?.BlockNumber || r);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {}
  return 9_223_372_036;
}

/* ---------------- Windowed log crawl with 400 fallback ---------------- */

async function getAllTransferLogs(token, {
  fromBlock,
  toBlock,
  initialWindow = 200_000,
  offset = 1000,
  maxWindows = 400
} = {}) {
  if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || fromBlock <= 0 || toBlock <= 0 || fromBlock > toBlock) {
    throw new Error(`bad block range ${fromBlock}..${toBlock}`);
  }

  const all = [];
  let start = fromBlock;
  let windows = 0;
  let windowSize = initialWindow;

  while (start <= toBlock && windows < maxWindows) {
    let end = Math.min(start + windowSize, toBlock);

    let page = 1;
    while (true) {
      const params = {
        module: 'logs',
        action: 'getLogs',
        address: token,
        topic0: TOPIC_TRANSFER,
        fromBlock: start,
        toBlock: end,
        page,
        offset,
      };

      try {
        const batch = await esGET(params, { tag: `logs ${start}-${end} p${page}` });
        if (!Array.isArray(batch) || batch.length === 0) break;
        all.push(...batch);
        if (batch.length < offset) break; // last page of this window
        page++;
      } catch (e) {
        const httpStatus = e?.response?.status;
        // If Etherscan says 400 for this window, shrink the window and retry once.
        if (httpStatus === 400 && windowSize > 10_000) {
          console.warn(`[INDEX] 400 on window ${start}-${end} — shrinking window from ${windowSize} to ${Math.floor(windowSize/2)}`);
          windowSize = Math.max(10_000, Math.floor(windowSize / 2));
          end = Math.min(start + windowSize, toBlock);
          page = 1; // restart this reduced window
          continue;
        }
        // Otherwise log and skip this window
        console.warn(`[INDEX] getLogs failed on ${start}-${end} (status ${httpStatus || 'n/a'}). Skipping this window.`);
        break;
      }
    }

    start = end + 1;
    windows++;
  }

  return all;
}

/* ---------------- Public: buildHoldersSnapshot ---------------- */

export async function buildHoldersSnapshot(tokenAddress, hints = {}) {
  const ca = String(tokenAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ca)) {
    return { ok: false, reason: 'bad_token' };
  }

  try {
    // Figure block range
    const [creationBlock, latestBlock] = await Promise.all([
      getCreationBlock(ca),
      getLatestBlock(),
    ]);
    if (!Number.isFinite(creationBlock) || creationBlock <= 0) {
      return { ok: false, reason: 'no_creation_block', tokenAddress: ca };
    }
    const fromB = Math.max(0, creationBlock - 1);
    const toB   = latestBlock;

    // Crawl logs with shrink-on-400
    const logs = await getAllTransferLogs(ca, {
      fromBlock: fromB,
      toBlock: toB,
      initialWindow: 200_000,
      offset: 1000,
      maxWindows: 500,
    });

    // Build balances
    const balances = new Map(); // addr -> bigint
    let burned = 0n;
    for (const lg of logs) {
      const from = topicToAddr(lg.topics[1]);
      const to   = topicToAddr(lg.topics[2]);
      const val  = toBig(lg.data);
      if (!DEAD.has(from)) balances.set(from, (balances.get(from) || 0n) - val);
      if (!DEAD.has(to))   balances.set(to,   (balances.get(to)   || 0n) + val);
      if (DEAD.has(to)) burned += val;
    }
    for (const [a, v] of balances) if (v <= 0n) balances.delete(a);

    // Totals
    // Prefer hint if present; else approximate as sum(balances)+burned
    let totalSupply = '0';
    if (hints.totalSupplyHint) {
      totalSupply = String(hints.totalSupplyHint);
    } else {
      try {
        const sum = [...balances.values()].reduce((acc, x) => acc + x, 0n);
        totalSupply = String(sum + burned);
      } catch {}
    }

    const supplyBig = BigInt(totalSupply || '0');

    // holdersAllPerc (percentage per holder)
    const holdersAllPerc = [];
    const rows = [];
    for (const [addr, bal] of balances.entries()) {
      if (bal <= 0n) continue;
      const pctTimes1e4 = supplyBig > 0n
        ? Number((bal * 1000000n) / supplyBig) / 10000
        : 0;
      holdersAllPerc.push(pctTimes1e4);
      rows.push([addr, bal, pctTimes1e4]);
    }

    // Sort for Top20
    rows.sort((A,B)=> (B[1] > A[1] ? 1 : (B[1] < A[1] ? -1 : 0)));
    const holdersTop20 = rows.slice(0, 20).map(([address, bal, percent]) => ({
      address,
      balance: String(bal),
      percent: Number(percent.toFixed(4)),
    }));

    const top10CombinedPct = Number(
      holdersTop20.slice(0,10).reduce((a, h) => a + (h.percent || 0), 0).toFixed(4)
    );

    // Bands by supply share
    const bands = { lt001:0, lt005:0, lt01:0, lt05:0, gte1:0 };
    for (const p of holdersAllPerc) {
      if (p < 0.01) bands.lt001++;
      else if (p < 0.05) bands.lt005++;
      else if (p < 0.1)  bands.lt01++;
      else if (p < 0.5)  bands.lt05++;
      else if (p >= 1)   bands.gte1++;
    }

    return {
      ok: true,
      tokenAddress: ca,
      holdersAllPerc,
      holdersTop20,
      holdersCount: rows.length,
      top10CombinedPct,
      burnedPct: supplyBig > 0n ? Number(((burned * 1000000n) / supplyBig)) / 10000 : 0,
      totalSupply,
      // let caller decide decimals; snapshot doesn’t know ERC20 decimals here
      percBands: bands,
      updatedAt: Date.now(),
    };
  } catch (e) {
    console.error('[INDEX] buildHoldersSnapshot failed:', e?.message || e);
    return { ok: false, reason: 'crawl_failed', error: e?.message || String(e) };
  }
}
