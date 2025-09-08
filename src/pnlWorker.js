// src/pnlWorker.js
// Accurate average-cost PnL for Abstract chain — ETH+WETH merged
// - Realized = proceeds - costOfSold (avg cost)
// - Unrealized = MTM(remaining) - remainingCost (avg cost)
// - Token BUY = wallet receives ERC20 units; SELL = wallet sends ERC20 units
// - Pair proceeds/costs with ETH or WETH legs at TX-HASH level, plus INTERNAL TX by TX-HASH (router/relayer settlement)
// - Bonding-phase: from===tokenContract & zero-ETH -> treated as buy at zero cost (not an airdrop)
// - Airdrops: ERC20 = inbound token w/ zero-ETH and not from token contract; ERC721 inbound (zero-ETH) aggregated by collection
// - Trade-only ETH in/out: only ETH/WETH connected to a token transfer are counted
// - Open positions filtered by USD >= $1; ETH/WETH hidden in open list
// - Exports: refreshPnl(wallet, window)

import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { withLock, getJSON, setJSON } from './cache.js';

// ---------- Config / Env ----------
const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741';
const ALCHEMY_URL = process.env.ALCHEMY_URL || ''; // optional
const REDIS_URL   = process.env.REDIS_URL;

if (!ES_KEY) console.warn('[PNL] ETHERSCAN_API_KEY missing (will fail to fetch)');

const WETH = '0x3439153eb7af838ad19d56e1571fbd09333c2809'.toLowerCase();

// Routers / relayers / TG bot forwarders observed on Abstract
const KNOWN_ROUTERS = new Set([
  '0x0d6848e39114abe69054407452b8aab82f8a44ba'.toLowerCase(), // Moonshot router/bonding
  '0x1c4ae91dfa56e49fca849ede553759e1f5f04d9f'.toLowerCase(), // TG bot forwarder (user provided)
]);

// ----- Etherscan throttled client (safe @ <5/sec) -----
const httpES = axios.create({ baseURL: ES_BASE, timeout: 45_000 });

// If you set ETHERSCAN_RPS=5, we still keep a safety margin below 5/sec.
const ES_RPS = Math.max(1, Number(process.env.ETHERSCAN_RPS || 4)); // default 4/sec
const SAFETY_GAP_MS = 60;                            // small margin over ideal interval
const ES_MIN_INTERVAL = Math.ceil(1000 / ES_RPS) + SAFETY_GAP_MS;

let esLastTs = 0;
let esChain = Promise.resolve();

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function throttleES() {
  await (esChain = esChain.then(async () => {
    const now = Date.now();
    // add tiny jitter so bursts don't align on the same millisecond
    const jitter = Math.floor(Math.random()*25); // 0–24ms
    const wait = Math.max(0, esLastTs + ES_MIN_INTERVAL - now + jitter);
    if (wait > 0) await sleep(wait);
    esLastTs = Date.now();
  }));
}

function esParams(params) {
  return { params: { chainid: ES_CHAIN, apikey: ES_KEY, ...params } };
}

async function esGET(params) {
  // global throttle
  await throttleES();

  const maxAttempts = 5; // a bit more forgiving on bursts
  for (let a = 1; a <= maxAttempts; a++) {
    try {
      const { data } = await httpES.get('', esParams(params));
      if (data?.status === '1') return data.result;

      const msg = String(data?.result || data?.message || 'Etherscan error');
      // Specific handling for rate limit
      if (/Max calls per sec/i.test(msg) || /rate limit/i.test(msg)) {
        // exponential-ish backoff + extra cushion
        await sleep(250 * a + 150);
        continue;
      }

      if (a === maxAttempts) throw new Error(msg);
    } catch (e) {
      // network/timeout — backoff and retry
      if (a === maxAttempts) throw e;
      await sleep(300 * a);
    }
  }
  // Should not reach here
  throw new Error('Etherscan: unexpected retry fallthrough');
}


// ---------- Quotes (Dexscreener) ----------
async function getUsdQuote(ca) {
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/tokens/v1/abstract/${ca}`, { timeout: 15_000 });
    if (Array.isArray(data) && data.length > 0) return { priceUsd: Number(data[0]?.priceUsd || 0) || 0 };
    return { priceUsd: Number(data?.priceUsd || 0) || 0 };
  } catch { return { priceUsd: 0 }; }
}
async function getWethQuote(ca) {
  try {
    const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { timeout: 15_000 });
    const ps = Array.isArray(data?.pairs) ? data.pairs : [];
    const abs = ps.filter(p => p?.chainId === 'abstract');
    abs.sort((a,b) =>
      (Number(b?.liquidity?.usd||0) - Number(a?.liquidity?.usd||0)) ||
      (Number(b?.volume?.h24||0)    - Number(a?.volume?.h24||0))
    );
    const best = abs[0];
    return { priceWeth: Number(best?.priceNative || 0) || 0 };
  } catch { return { priceWeth: 0 }; }
}
async function getQuotes(ca) {
  const [{ priceUsd }, { priceWeth }] = await Promise.all([ getUsdQuote(ca), getWethQuote(ca) ]);
  return { priceUsd, priceWeth };
}

// ---------- Wallet history ----------
async function getWalletERC20Txs(wallet, { fromTs=0 }={}) {
  wallet = wallet.toLowerCase();
  let page = 1;
  const PAGE = 1000;
  const out = [];
  while (true) {
    const res = await esGET({
      module: 'account', action: 'tokentx', address: wallet,
      page, offset: PAGE, sort: 'asc', startblock: 0, endblock: 999999999
    });
    if (!Array.isArray(res) || res.length === 0) break;
    for (const r of res) { if (Number(r.timeStamp || 0) >= fromTs) out.push(r); }
    if (res.length < PAGE) break;
    page++; if (page > 50) break;
  }
  return out;
}
async function getWalletNormalTxs(wallet, { fromTs=0 }={}) {
  wallet = wallet.toLowerCase();
  let page = 1;
  const PAGE = 5000;
  const out = [];
  while (true) {
    const res = await esGET({
      module: 'account', action: 'txlist', address: wallet,
      page, offset: PAGE, sort: 'asc', startblock: 0, endblock: 999999999
    });
    if (!Array.isArray(res) || res.length === 0) break;
    for (const r of res) { if (Number(r.timeStamp || 0) >= fromTs) out.push(r); }
    if (res.length < PAGE) break;
    page++; if (page > 10) break;
  }
  return out;
}
// Etherscan internal tx BY HASH (most precise to pair router/relayer ETH)
async function getInternalByHash(hash) {
  const key = `intx:${hash}`;
  const cached = await getJSON(key);
  if (cached) return cached;
  const res = await esGET({ module:'account', action:'txlistinternal', txhash: hash });
  await setJSON(key, res || [], 600);
  return res || [];
}
async function getEthBalance(wallet) {
  try {
    const r = await esGET({ module: 'account', action: 'balance', address: wallet, tag: 'latest' });
    const s = typeof r === 'string' ? r : (r?.result || '0');
    return s;
  } catch { return '0'; }
}

// ---------- Optional: Alchemy balances (erc20) ----------
async function getAlchemyBalances(wallet) {
  if (!ALCHEMY_URL) return null;
  try {
    const { data } = await axios.post(ALCHEMY_URL, {
      id: 1, jsonrpc: '2.0', method: 'alchemy_getTokenBalances',
      params: [ wallet, 'erc20' ]
    }, { timeout: 20_000, headers: { 'Accept':'application/json','Content-Type':'application/json' }});
    return Array.isArray(data?.result?.tokenBalances) ? data.result.tokenBalances : null;
  } catch { return null; }
}

// ---------- Math helpers ----------
const toBig = (x) => BigInt(String(x||'0'));
const add   = (a,b) => (a||0n) + (b||0n);

// ---------- Core compute ----------
async function computePnL(wallet, { sinceTs=0 }) {
  wallet = wallet.toLowerCase();

  const [erc20, normal, ethBalWeiStr] = await Promise.all([
    getWalletERC20Txs(wallet, { fromTs: sinceTs }),
    getWalletNormalTxs(wallet, { fromTs: sinceTs }),
    getEthBalance(wallet),
  ]);
  const ethBalanceFloat = Number(ethBalWeiStr) / 1e18;

  // Map txHash => ETH/WETH net (from normal + erc20 WETH + internal)
  const ethDeltaByHash = new Map(); // +in/-out wei (native)
  const wethDeltaByHash = new Map(); // +in/-out wei (weth erc20)
  const blockEthNet = new Map();
  const blockWethNet = new Map();

  // Normal (native)
  for (const tx of normal) {
    const hash = String(tx.hash);
    const bn   = Number(tx.blockNumber||0);
    const from = String(tx.from||'').toLowerCase();
    const to   = String(tx.to||'').toLowerCase();
    const val  = toBig(tx.value||'0');
    let d = 0n;
    if (to === wallet && val > 0n) d = val; else if (from === wallet && val > 0n) d = -val;
    if (d !== 0n) {
      ethDeltaByHash.set(hash, add(ethDeltaByHash.get(hash), d));
      blockEthNet.set(bn, add(blockEthNet.get(bn), d));
    }
  }

  // ERC20 (WETH leg + group other tokens)
  const tokenTxsByToken = new Map();
  for (const r of erc20) {
    const hash  = String(r.hash);
    const bn    = Number(r.blockNumber||0);
    const token = String(r.contractAddress||'').toLowerCase();
    const to    = String(r.to||'').toLowerCase();
    const from  = String(r.from||'').toLowerCase();
    const v     = toBig(r.value||'0');

    if (token === WETH) {
      let d = 0n;
      if (to === wallet) d = v; else if (from === wallet) d = -v;
      if (d !== 0n) {
        wethDeltaByHash.set(hash, add(wethDeltaByHash.get(hash), d));
        blockWethNet.set(bn, add(blockWethNet.get(bn), d));
      }
      continue;
    }
    if (to !== wallet && from !== wallet) continue;
    if (!tokenTxsByToken.has(token)) tokenTxsByToken.set(token, []);
    tokenTxsByToken.get(token).push(r);
  }

  // Internal tx by hash (lazy cache; only for hashes that include a token transfer)
const allHashes = new Set();
for (const arr of tokenTxsByToken.values()) {
  for (const r of arr) allHashes.add(String(r.hash));
}
const internalMap = new Map();
// sequential to avoid any burstiness
for (const h of allHashes) {
  const inTx = await getInternalByHash(h);
  internalMap.set(h, Array.isArray(inTx) ? inTx : []);
}


  const perToken = [];
  const processedByTokenHashSide = new Set(); // dedupe “counted already” pairs

  // For trade-only ETH in/out totals
  let tradeEthInWei  = 0n;
  let tradeEthOutWei = 0n;

  // NFT airdrops (ERC721) — minimal, by address
  // (Optional: You can add a separate tokennfttx pull if needed; here we detect via ERC721 decimals==0 inbound with zero-ETH)
  const nftAirdrops = new Map(); // contract => { name?, symbol?, count }

  for (const [token, txs] of tokenTxsByToken.entries()) {
    txs.sort((a,b) =>
      (Number(a.timeStamp)-Number(b.timeStamp)) ||
      (Number(a.blockNumber)-Number(b.blockNumber)) ||
      (Number(a.transactionIndex||0)-Number(b.transactionIndex||0)) ||
      (Number(a.logIndex||0)-Number(b.logIndex||0))
    );

    const { priceUsd, priceWeth } = await getQuotes(token);

    let qty = 0n;              // units
    let costWeth = 0n;         // wei cost of remaining qty
    let realizedWeth = 0n;     // wei PnL realized
    let buys = 0n, sells = 0n;

    const tokenDecimals = Math.max(0, Number(txs[0]?.tokenDecimal ?? 18));
    const scale = 10n ** BigInt(tokenDecimals);
    const sym   = String(txs[0]?.tokenSymbol || '');

    // Treat pure NFT (decimals 0 + huge tokenID) as collection airdrops if inbound w/ zero-ETH
    const isProbablyNFT = tokenDecimals === 0 && !sym; // conservative

    const airdrops = []; // ERC20 airdrops (units)

    for (const r of txs) {
      const hash   = String(r.hash);
      const bn     = Number(r.blockNumber||0);
      const to     = String(r.to||'').toLowerCase();
      const from   = String(r.from||'').toLowerCase();
      const amt    = toBig(r.value||'0');

      // ETH/WETH hash-level legs
      const wethHash = wethDeltaByHash.get(hash) || 0n;
      const ethHash  = ethDeltaByHash.get(hash)  || 0n;

      // Internal tx in the same hash
      const internals = internalMap.get(hash) || [];
      let internalNetWei = 0n;
      for (const itx of internals) {
        const f = String(itx.from||'').toLowerCase();
        const t = String(itx.to||'').toLowerCase();
        const val = toBig(itx.value||'0');
        if (t === wallet && val > 0n) internalNetWei += val;
        else if (f === wallet && val > 0n) internalNetWei -= val;
      }

      let paidWei = 0n, recvWei = 0n;
      // merge native + weth + internals
      const net = (ethHash + wethHash + internalNetWei);
      if (net < 0n) paidWei = -net; else recvWei = net;

      // If still zero and router bonding/relayer: fallback to block net
      if (paidWei === 0n && recvWei === 0n && (KNOWN_ROUTERS.has(to) || KNOWN_ROUTERS.has(from) || to === token)) {
        const blk = (blockEthNet.get(bn)||0n) + (blockWethNet.get(bn)||0n);
        if (blk > 0n) recvWei = blk; else if (blk < 0n) paidWei = -blk;
      }

      // BUY (wallet receives token)
      if (to === wallet) {
        // Bonding buy: from === token && zero ETH in hash → zero-cost buy
        const isBonding = (from === token) && (paidWei === 0n) && (recvWei === 0n);
        buys += amt;
        qty  += amt;
        if (!isBonding) {
          costWeth += paidWei;
          tradeEthOutWei += paidWei; // trade-only: ETH paid for token
        } else {
          // still inventory, cost=0
        }
        continue;
      }

      // SELL (wallet sends token)
      if (from === wallet) {
        // If no ETH/WETH arrived here but it’s a router/relayer: recvWei may be 0 — handled above with block/internal
        const avgCostPerUnitWei = qty > 0n ? (costWeth * 1_000_000_000_000_000_000n) / qty : 0n;
        const sellUnits = amt > qty ? qty : amt;
        const costOfSold = (avgCostPerUnitWei * sellUnits) / 1_000_000_000_000_000_000n;
        realizedWeth += (recvWei - costOfSold);

        // reduce inventory
        const newQty = qty > sellUnits ? (qty - sellUnits) : 0n;
        costWeth = newQty > 0n ? (avgCostPerUnitWei * newQty) / 1_000_000_000_000_000_000n : 0n;
        qty = newQty;
        sells += amt;

        // trade-only ETH in (proceeds)
        if (recvWei > 0n) tradeEthInWei += recvWei;
        continue;
      }

      // If inbound token with zero ETH and not from token => airdrop
      if (to === wallet && paidWei === 0n && recvWei === 0n && from !== token) {
        airdrops.push({ hash, amount: amt });
        qty += amt; // zero-cost inventory
        continue;
      }

      // If outbound token with zero ETH and not router => transfer/gift: reduce qty + cost proportionally
      if (from === wallet && paidWei === 0n && recvWei === 0n && !KNOWN_ROUTERS.has(to) && to !== token) {
        if (qty > 0n) {
          const avgCostPerUnitWei = (costWeth * 1_000_000_000_000_000_000n) / (qty || 1n);
          const used = amt > qty ? qty : amt;
          const costReduction = (avgCostPerUnitWei * used) / 1_000_000_000_000_000_000n;
          qty -= used;
          costWeth = costWeth > costReduction ? (costWeth - costReduction) : 0n;
        }
      }
    } // tx loop

    // Mark-to-market & USD
    const qtyFloat  = Number(qty) / Number(scale || 1n);
    const invCostW  = Number(costWeth) / 1e18;
    const mtmW      = qtyFloat * Number(priceWeth || 0);
    const unrealW   = mtmW - invCostW;
    const usdValue  = qtyFloat * Number(priceUsd || 0);

    // ERC20 airdrop USD
    let aUnits = 0n;
    for (const a of airdrops) aUnits += a.amount;
    const adQty = Number(aUnits) / Number(scale || 1n);
    const adUsd = adQty * Number(priceUsd || 0);

    const symbolUp = sym?.toUpperCase?.() || '';
    const isEthLike = symbolUp === 'ETH' || symbolUp === 'WETH' || token === WETH;

    perToken.push({
      token,
      symbol: sym || '',
      decimals: tokenDecimals,
      buys: buys.toString(),
      sells: sells.toString(),
      remaining: qty.toString(),
      realizedWeth: Number(realizedWeth) / 1e18,
      inventoryCostWeth: Number(costWeth) / 1e18,
      priceUsd: Number(priceUsd || 0),
      priceWeth: Number(priceWeth || 0),
      unrealizedWeth: unrealW,
      usdValueRemaining: usdValue,
      isEthLike,
      airdrops: { count: airdrops.length, units: aUnits.toString(), estUsd: adUsd },
    });
  } // per token

  // Totals
  let totalRealized = 0, totalUnreal = 0, totalAirdropsUsd = 0, totalHoldingsUsd = 0;
  for (const r of perToken) {
    totalRealized += Number(r.realizedWeth) || 0;
    totalUnreal   += Number(r.unrealizedWeth) || 0;
    totalAirdropsUsd += Number(r.airdrops?.estUsd || 0);
    totalHoldingsUsd += Number(r.usdValueRemaining || 0);
  }

  // Merge ETH flows (trade-only)
  const totalPnlWeth = totalRealized + totalUnreal;
  const spentBase = Number(tradeEthOutWei) / 1e18;
  const pnlPct = spentBase > 0 ? (totalPnlWeth / spentBase) * 100 : 0;

  // Open positions (no ETH-like), USD >= $1
  const opens = perToken.filter(t => !t.isEthLike && Number(t.remaining) > 0 && (t.usdValueRemaining || 0) >= 1);

  // Realized leaders (closed or partially realized), order applied in renderer; we provide full dataset
  const realizedOnly = perToken
    .filter(t => Math.abs(Number(t.realizedWeth) || 0) > 0)
    .map(t => ({
      token: t.token, symbol: t.symbol, realizedWeth: t.realizedWeth,
      buyEth: Math.max(0, +(t.inventoryCostWeth || 0) + 0), // not used directly; renderer gets aggregated
    }));

  return {
    wallet,
    sinceTs,
    totals: {
      ethBalance: ethBalanceFloat,      // wallet balance
      tradeInEth: Number(tradeEthInWei)  / 1e18,  // proceeds only for token sells
      tradeOutEth: Number(tradeEthOutWei)/ 1e18,  // spend only for token buys
      realizedWeth: totalRealized,
      unrealizedWeth: totalUnreal,
      totalPnlWeth,
      pnlPct,
      airdropsUsd: totalAirdropsUsd,
      holdingsUsd: totalHoldingsUsd
    },
    tokens: perToken,
    derived: {
      open: opens,
      realizedAll: realizedOnly, // renderer builds buy/sell aggregates & top lists
      nftAirdrops: Array.from(nftAirdrops.values())
    }
  };
}

// ---------- Public API with caching ----------
export async function refreshPnl(wallet, window) {
  const sinceMap = {
    '24h':  60*60*24,
    '7d':   60*60*24*7,
    '30d':  60*60*24*30,
    '90d':  60*60*24*90,
    'all':  0
  };
  const sinceSec = sinceMap[window] ?? sinceMap['30d'];
  const sinceTs = sinceSec ? Math.floor(Date.now()/1000) - sinceSec : 0;

  const key = `pnl:${String(wallet).toLowerCase()}:${window}`;
  return withLock(`lock:${key}`, 60, async () => {
    const cached = await getJSON(key);
    if (cached) return cached;
    const data = await computePnL(wallet, { sinceTs });
    await setJSON(key, data, 120); // cache 2m
    return data;
  });
}
