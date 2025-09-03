// src/pnlWorker.js
// Precise, API-efficient PnL for Abstract chain.
// - Pull once per window: txlist, tokentx, txlistinternal, tokennfttx
// - ETH leg pairing: same-tx → internal-tx → same-block → ±2 blocks (catches routers/proxies & bonding)
// - ETH in/out only from matched trade legs (no random transfers)
// - Realized PnL = average-cost; best/worst are realized-only
// - Open positions only for current holdings; expose usdValueRemaining to filter <$1 in renderer
// - NFT airdrops (collection + count)
// - Exports: refreshPnl(), pnlQueueName, pnlQueue, worker

import './configEnv.js';
import axios from 'axios';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { setJSON, getJSON, withLock } from './cache.js';

// ---------- Chain / API ----------
const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741';
if (!ES_KEY) console.warn('[PNL BOOT] ETHERSCAN_API_KEY missing');

const WETH = '0x3439153eb7af838ad19d56e1571fbd09333c2809'.toLowerCase(); // Abstract WETH

// Moonshot / TG proxy / other routers you want treated as settlement peers
const KNOWN_ROUTERS = new Set([
  '0x0d6848e39114abe69054407452b8aab82f8a44ba'.toLowerCase(), // Moonshot router
  '0x1c4ae91dfa56e49fca849ede553759e1f5f04d9f'.toLowerCase(), // TG proxy/forwarder
]);

// ---------- HTTP client & throttle (≤ 5 rps) ----------
const httpES = axios.create({ baseURL: ES_BASE, timeout: 45_000 });
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
function esParams(params) { return { params: { chainid: ES_CHAIN, apikey: ES_KEY, ...params } }; }
async function esGET(params, { tag='' }={}) {
  await throttleES();
  const maxAttempts = 3;
  for (let a=1; a<=maxAttempts; a++) {
    try {
      const { data } = await httpES.get('', esParams(params));
      if (data?.status === '1') return data.result;
      const msg = data?.result || data?.message || 'Unknown Etherscan error';
      if (a === maxAttempts) throw new Error(`Etherscan v2 error: ${msg} :: ${tag}`);
    } catch (e) { if (a === maxAttempts) throw e; }
    await new Promise(r => setTimeout(r, 300*a));
  }
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
const quoteCache = new Map(); // token -> {priceUsd, priceWeth, ts}
async function getQuotes(ca, needUsdAndWeth=true) {
  const key = ca.toLowerCase();
  const now = Date.now();
  const cached = quoteCache.get(key);
  if (cached && (now - cached.ts) < 60_000) return { priceUsd: cached.priceUsd, priceWeth: cached.priceWeth };
  if (needUsdAndWeth) {
    const [{ priceUsd }, { priceWeth }] = await Promise.all([ getUsdQuote(key), getWethQuote(key) ]);
    quoteCache.set(key, { priceUsd, priceWeth, ts: now });
    return { priceUsd, priceWeth };
  } else {
    // If we only need USD (e.g., for open positions), still fill both keys
    const { priceUsd } = await getUsdQuote(key);
    const { priceWeth } = await getWethQuote(key);
    quoteCache.set(key, { priceUsd, priceWeth, ts: now });
    return { priceUsd, priceWeth };
  }
}

// ---------- Etherscan pulls ----------
async function getWalletERC20Txs(wallet, { fromTs=0 }={}) {
  wallet = wallet.toLowerCase();
  let page = 1;
  const PAGE = 1000;
  const out = [];
  while (true) {
    const res = await esGET({
      module: 'account',
      action: 'tokentx',
      address: wallet,
      page,
      offset: PAGE,
      sort: 'asc',
      startblock: 0,
      endblock: 999999999
    }, { tag:'tokentx' });

    if (!Array.isArray(res) || res.length === 0) break;
    for (const r of res) {
      const t = Number(r.timeStamp || 0);
      if (t >= fromTs) out.push(r);
    }
    if (res.length < PAGE) break;
    page++;
    if (page > 60) { console.warn('[PNL] tokentx page cap hit'); break; }
  }
  return out;
}
async function getWalletNormalTxs(wallet, { fromTs=0 }={}) {
  wallet = wallet.toLowerCase();
  let page = 1;
  const PAGE = 10000;
  const out = [];
  while (true) {
    const res = await esGET({
      module: 'account',
      action: 'txlist',
      address: wallet,
      page,
      offset: PAGE,
      sort: 'asc',
      startblock: 0,
      endblock: 999999999
    }, { tag:'txlist' });

    if (!Array.isArray(res) || res.length === 0) break;
    for (const r of res) {
      const t = Number(r.timeStamp || 0);
      if (t >= fromTs) out.push(r);
    }
    if (res.length < PAGE) break;
    page++;
    if (page > 6) { console.warn('[PNL] txlist page cap hit'); break; }
  }
  return out;
}
async function getWalletInternalTxs(wallet, { fromTs=0 }={}) {
  wallet = wallet.toLowerCase();
  let page = 1;
  const PAGE = 10000;
  const out = [];
  while (true) {
    const res = await esGET({
      module: 'account',
      action: 'txlistinternal',
      address: wallet,
      page,
      offset: PAGE,
      sort: 'asc',
      startblock: 0,
      endblock: 999999999
    }, { tag:'txlistinternal' });

    if (!Array.isArray(res) || res.length === 0) break;
    for (const r of res) {
      const t = Number(r.timeStamp || 0);
      if (t >= fromTs) out.push(r);
    }
    if (res.length < PAGE) break;
    page++;
    if (page > 10) { console.warn('[PNL] internal page cap hit'); break; }
  }
  return out;
}
async function getWalletNFTTxs(wallet, { fromTs=0 }={}) {
  wallet = wallet.toLowerCase();
  let page = 1;
  const PAGE = 1000;
  const out = [];
  while (true) {
    const res = await esGET({
      module: 'account',
      action: 'tokennfttx',
      address: wallet,
      page,
      offset: PAGE,
      sort: 'asc',
      startblock: 0,
      endblock: 999999999
    }, { tag:'tokennfttx' });

    if (!Array.isArray(res) || res.length === 0) break;
    for (const r of res) {
      const t = Number(r.timeStamp || 0);
      if (t >= fromTs) out.push(r);
    }
    if (res.length < PAGE) break;
    page++;
    if (page > 20) { console.warn('[PNL] nfttx page cap hit'); break; }
  }
  return out;
}
async function getEthBalance(wallet) {
  try {
    const res = await esGET({ module: 'account', action: 'balance', address: wallet, tag: 'latest' }, { tag:'balance' });
    // result can be a string or {result:string}
    return typeof res === 'string' ? res : (res?.result || '0');
  } catch { return '0'; }
}

// ---------- Math ----------
const toBig = (x) => BigInt(String(x));
const add   = (a,b) => (a||0n) + (b||0n);

// ---------- Core compute ----------
async function computePnL(wallet, { sinceTs=0 }) {
  wallet = wallet.toLowerCase();

  // Pull histories & balance (4 Etherscan calls total)
  const [erc20, normal, internalTx, nfttx, ethBalWeiStr] = await Promise.all([
    getWalletERC20Txs(wallet, { fromTs: sinceTs }),
    getWalletNormalTxs(wallet, { fromTs: sinceTs }),
    getWalletInternalTxs(wallet, { fromTs: sinceTs }),
    getWalletNFTTxs(wallet, { fromTs: sinceTs }),
    getEthBalance(wallet),
  ]);
  const ethBalanceFloat = Number(ethBalWeiStr) / 1e18;

  // -------- Build ETH-equivalent legs per tx-hash (native + internal + WETH) --------
  const ethEqInByHash  = new Map(); // wei to wallet
  const ethEqOutByHash = new Map(); // wei from wallet
  const ethEqNetByBlock = new Map(); // block -> net (in - out) wei, for near-block matching

  const bumpIn  = (h, v) => ethEqInByHash.set(h, add(ethEqInByHash.get(h), v));
  const bumpOut = (h, v) => ethEqOutByHash.set(h, add(ethEqOutByHash.get(h), v));
  const bumpBlk = (bn, v) => ethEqNetByBlock.set(bn, add(ethEqNetByBlock.get(bn), v));

  const blocksSeen = new Set();

  // Native ETH (txlist)
  for (const tx of normal) {
    const hash = String(tx.hash);
    const bn   = Number(tx.blockNumber || 0);
    blocksSeen.add(bn);
    const from = String(tx.from || '').toLowerCase();
    const to   = String(tx.to   || '').toLowerCase();
    const val  = toBig(tx.value || '0');
    if (val === 0n) continue;
    if (to === wallet) { bumpIn(hash, val);  bumpBlk(bn, val);  }
    else if (from === wallet) { bumpOut(hash, val); bumpBlk(bn, -val); }
  }

  // Internal ETH (txlistinternal)
  for (const itx of internalTx) {
    const hash = String(itx.hash);
    const bn   = Number(itx.blockNumber || 0);
    blocksSeen.add(bn);
    const from = String(itx.from || '').toLowerCase();
    const to   = String(itx.to   || '').toLowerCase();
    const val  = toBig(itx.value || '0');
    if (val === 0n) continue;
    if (to === wallet) { bumpIn(hash, val);  bumpBlk(bn, val);  }
    else if (from === wallet) { bumpOut(hash, val); bumpBlk(bn, -val); }
  }

  // WETH ERC20 transfers count as ETH-equivalent legs (1:1)
  for (const r of erc20) {
    if (String(r.contractAddress||'').toLowerCase() !== WETH) continue;
    const hash = String(r.hash);
    const bn   = Number(r.blockNumber || 0);
    blocksSeen.add(bn);
    const to   = String(r.to   || '').toLowerCase();
    const from = String(r.from || '').toLowerCase();
    const v    = toBig(r.value || '0');
    if (v === 0n) continue;
    if (to === wallet) { bumpIn(hash, v);  bumpBlk(bn, v);  }
    else if (from === wallet) { bumpOut(hash, v); bumpBlk(bn, -v); }
  }

  // Group token transfers (non-WETH) by contract
  const tokenTxsByToken = new Map();
  for (const r of erc20) {
    const token = String(r.contractAddress || '').toLowerCase();
    if (token === WETH) continue; // already used for ETH legs
    const to   = String(r.to   || '').toLowerCase();
    const from = String(r.from || '').toLowerCase();
    if (to !== wallet && from !== wallet) continue;
    if (!tokenTxsByToken.has(token)) tokenTxsByToken.set(token, []);
    tokenTxsByToken.get(token).push(r);
  }

  // For near-block search
  const allBlocks = [...blocksSeen].sort((a,b)=>a-b);
  const blockIndex = new Map(allBlocks.map((bn,i)=>[bn,i]));

  const perToken = [];
  let tradedEthInWei  = 0n; // sells proceeds (ETH/WETH)
  let tradedEthOutWei = 0n; // buys cost (ETH/WETH)

  const ONE = 1_000_000_000_000_000_000n;

  for (const [token, txs] of tokenTxsByToken.entries()) {
    txs.sort((a,b) =>
      (Number(a.timeStamp) - Number(b.timeStamp)) ||
      (Number(a.blockNumber) - Number(b.blockNumber)) ||
      (Number(a.transactionIndex||0) - Number(b.transactionIndex||0)) ||
      (Number(a.logIndex||0) - Number(b.logIndex||0))
    );

    // We only need quotes for open positions / airdrops (later)
    let qty = 0n;              // units held
    let costW = 0n;            // cost basis for remaining (wei)
    let realizedW = 0n;        // realized PnL (wei)
    let buys = 0n, sells = 0n;

    const tokenDecimals = Math.max(0, Number(txs[0]?.tokenDecimal || 18));
    const scale = 10n ** BigInt(tokenDecimals);

    const airdrops = [];
    const unmatchedBuys  = [];
    const unmatchedSells = [];

    const sym = txs[0]?.tokenSymbol || '';

    for (const r of txs) {
      const hash = String(r.hash);
      const bn   = Number(r.blockNumber || 0);
      const to   = String(r.to   || '').toLowerCase();
      const from = String(r.from || '').toLowerCase();
      const amt  = toBig(r.value || '0');

      const paidWei = ethEqOutByHash.get(hash) || 0n; // ETH/WETH out from wallet
      const recvWei = ethEqInByHash.get(hash)  || 0n; // ETH/WETH in to wallet

      // BUY heuristics
      if (to === wallet) {
        if (paidWei > 0n) {
          buys += amt; qty += amt; costW += paidWei;
          tradedEthOutWei += paidWei;
          continue;
        }
        if (from === token || KNOWN_ROUTERS.has(from)) {
          // try same-block or near-block net out
          let paid = 0n;
          const net = ethEqNetByBlock.get(bn) || 0n;
          if (net < 0n) paid = -net;
          else {
            const idx = blockIndex.get(bn) ?? -1;
            if (idx >= 0) {
              for (let di of [1,2]) {
                const L = allBlocks[idx - di], R = allBlocks[idx + di];
                if (L != null) { const x = ethEqNetByBlock.get(L) || 0n; if (x < 0n) { paid = -x; break; } }
                if (R != null) { const x = ethEqNetByBlock.get(R) || 0n; if (x < 0n) { paid = -x; break; } }
              }
            }
          }
          if (paid > 0n) {
            buys += amt; qty += amt; costW += paid;
            tradedEthOutWei += paid;
            continue;
          }
          // queue; may be airdrop later
          unmatchedBuys.push({ bn, amt });
          continue;
        }
        // not sure yet: queue
        unmatchedBuys.push({ bn, amt });
        continue;
      }

      // SELL heuristics
      if (from === wallet) {
        if (recvWei > 0n) {
          sells += amt;
          const avg = qty > 0n ? (costW * ONE) / qty : 0n;
          const used = amt > qty ? qty : amt;
          const costOfSold = (avg * used) / ONE;

          realizedW += (recvWei - costOfSold);
          tradedEthInWei += recvWei;

          const newQty = qty > used ? (qty - used) : 0n;
          costW = newQty > 0n ? (avg * newQty) / ONE : 0n;
          qty = newQty;
          continue;
        }
        // router/proxy or token address
        if (KNOWN_ROUTERS.has(to) || to === token) {
          let recv = 0n;
          const net = ethEqNetByBlock.get(bn) || 0n;
          if (net > 0n) recv = net;
          else {
            const idx = blockIndex.get(bn) ?? -1;
            if (idx >= 0) {
              for (let di of [1,2]) {
                const L = allBlocks[idx - di], R = allBlocks[idx + di];
                if (L != null) { const x = ethEqNetByBlock.get(L) || 0n; if (x > 0n) { recv = x; break; } }
                if (R != null) { const x = ethEqNetByBlock.get(R) || 0n; if (x > 0n) { recv = x; break; } }
              }
            }
          }
          if (recv > 0n) {
            sells += amt;
            const avg = qty > 0n ? (costW * ONE) / qty : 0n;
            const used = amt > qty ? qty : amt;
            const costOfSold = (avg * used) / ONE;

            realizedW += (recv - costOfSold);
            tradedEthInWei += recv;

            const newQty = qty > used ? (qty - used) : 0n;
            costW = newQty > 0n ? (avg * newQty) / ONE : 0n;
            qty = newQty;
            continue;
          }
          // queue; may be internal gift, etc.
          unmatchedSells.push({ bn, amt });
          continue;
        }
        // unknown proceeds: queue
        unmatchedSells.push({ bn, amt });
        continue;
      }
    }

    // Resolve unmatched by near-block net
    for (const u of unmatchedBuys) {
      const { bn, amt } = u;
      let paid = 0n;
      const idx = blockIndex.get(bn) ?? -1;
      if (idx >= 0) {
        for (let di of [0,1,2]) {
          for (const side of [-1, +1]) {
            const pos = idx + side*di;
            if (pos < 0 || pos >= allBlocks.length) continue;
            const net = ethEqNetByBlock.get(allBlocks[pos]) || 0n;
            if (net < 0n) { paid = -net; break; }
          }
          if (paid > 0n) break;
        }
      }
      if (paid > 0n) {
        buys += amt; qty += amt; costW += paid;
        tradedEthOutWei += paid;
      } else {
        // treat as airdrop (zero-cost)
        airdrops.push({ amount: amt });
        qty += amt;
      }
    }
    for (const u of unmatchedSells) {
      const { bn, amt } = u;
      let recv = 0n;
      const idx = blockIndex.get(bn) ?? -1;
      if (idx >= 0) {
        for (let di of [0,1,2]) {
          for (const side of [-1, +1]) {
            const pos = idx + side*di;
            if (pos < 0 || pos >= allBlocks.length) continue;
            const net = ethEqNetByBlock.get(allBlocks[pos]) || 0n;
            if (net > 0n) { recv = net; break; }
          }
          if (recv > 0n) break;
        }
      }
      if (recv > 0n) {
        sells += amt;
        const avg = qty > 0n ? (costW * ONE) / qty : 0n;
        const used = amt > qty ? qty : amt;
        const costOfSold = (avg * used) / ONE;

        realizedW += (recv - costOfSold);
        tradedEthInWei += recv;

        const newQty = qty > used ? (qty - used) : 0n;
        costW = newQty > 0n ? (avg * newQty) / ONE : 0n;
        qty = newQty;
      } else {
        // treat as gift/internal: reduce basis proportionally
        if (qty > 0n) {
          const avg = (costW * ONE) / (qty || 1n);
          const used = amt > qty ? qty : amt;
          const red = (avg * used) / ONE;
          qty -= used;
          costW = costW > red ? (costW - red) : 0n;
        }
      }
    }

    // Quotes only if we still hold or had airdrops to value
    let priceUsd = 0, priceWeth = 0;
    const needQuote = qty > 0n || (airdrops.length > 0);
    if (needQuote) {
      const q = await getQuotes(token, true);
      priceUsd = Number(q.priceUsd || 0);
      priceWeth = Number(q.priceWeth || 0);
    }

    // MTM (for open positions & totals only; NOT used in best/worst)
    const qtyFloat = Number(qty) / Number(scale || 1n);
    const invCostE = Number(costW) / 1e18;
    const mtmE     = qtyFloat * Number(priceWeth || 0);
    const unrealE  = mtmE - invCostE;
    const usdVal   = qtyFloat * Number(priceUsd || 0);

    // Dust filter for OPEN positions (<5 tokens), but keep closed for realized stats
    const symUp = String(sym || '').toUpperCase();
    const isEthLike = (symUp === 'ETH') || (symUp === 'WETH') || (token === WETH);
    const MIN_UNITS = 5n * (10n ** BigInt(tokenDecimals));
    const isOpen = qty > 0n;
    const isDustOpen = isOpen && !isEthLike && qty < MIN_UNITS;

    if (!isDustOpen) {
      perToken.push({
        token,
        symbol: sym || '',
        decimals: tokenDecimals,

        buys: buys.toString(),
        sells: sells.toString(),
        remaining: qty.toString(),

        realizedWeth: Number(realizedW) / 1e18,     // ETH
        inventoryCostWeth: Number(costW) / 1e18,    // ETH

        priceUsd: Number(priceUsd || 0),
        priceWeth: Number(priceWeth || 0),

        unrealizedWeth: unrealE,                    // ETH (for totals/open only)
        usdValueRemaining: usdVal,                  // USD (for open positions)

        airdrops: {
          count: airdrops.length,
          units: (airdrops.reduce((s,a)=> s + (a.amount||0n), 0n)).toString(),
          estUsd: (Number(priceUsd || 0) * (Number((airdrops.reduce((s,a)=> s + (a.amount||0n), 0n))) / Number(scale || 1n)))
        }
      });
    }
  }

  // NFT airdrops: inbound ERC-721/1155 to wallet
  const nftMap = new Map(); // contract -> { collection, count }
  for (const n of nfttx) {
    const to = String(n.to || '').toLowerCase();
    if (to !== wallet) continue;
    const key = String(n.contractAddress || '').toLowerCase();
    const collection = n.tokenName || n.tokenSymbol || key.slice(0,10);
    const prev = nftMap.get(key) || { collection, count: 0 };
    prev.count += 1;
    nftMap.set(key, prev);
  }
  const nftDrops = [...nftMap.values()].map(x => ({ collection: x.collection, count: x.count }));

  // Totals across tokens
  let totalRealizedE = 0;
  let totalUnrealizedE = 0;
  let totalAirdropUsd = 0;
  let totalHoldingsUsd = 0;
  for (const r of perToken) {
    totalRealizedE   += Number(r.realizedWeth) || 0;
    totalUnrealizedE += Number(r.unrealizedWeth) || 0;
    totalAirdropUsd  += Number(r.airdrops?.estUsd || 0);
    totalHoldingsUsd += Number(r.usdValueRemaining || 0);
  }

  // ETH totals shown = trade legs only (combined ETH+WETH)
  const ethInFloat  = Number(tradedEthInWei)  / 1e18;
  const ethOutFloat = Number(tradedEthOutWei) / 1e18;

  const totalPnlE = totalRealizedE + totalUnrealizedE;
  const spentBase = ethOutFloat; // only what you spent on buys
  const pnlPct    = spentBase > 0 ? (totalPnlE / spentBase) * 100 : 0;

  // Derived sets
  const openPositions = perToken.filter(t => Number(t.remaining) > 0);
  const airdropsFlat  = perToken
    .filter(t => (t.airdrops?.count || 0) > 0)
    .map(t => ({ token: t.token, symbol: t.symbol, decimals: t.decimals, units: t.airdrops.units, estUsd: t.airdrops.estUsd }));

  // Realized-only leaders
  const realizedOnlyPos = perToken.filter(t => (Number(t.realizedWeth) || 0) > 0);
  const realizedOnlyNeg = perToken.filter(t => (Number(t.realizedWeth) || 0) < 0);
  const best  = realizedOnlyPos.sort((a,b)=> (Number(b.realizedWeth)||0) - (Number(a.realizedWeth)||0)).slice(0, 15);
  const worst = realizedOnlyNeg.sort((a,b)=> (Number(a.realizedWeth)||0) - (Number(b.realizedWeth)||0)).slice(0, 15);

  return {
    wallet,
    sinceTs,
    totals: {
      ethBalance: ethBalanceFloat, // native ETH wallet balance

      // trade-only ETH legs (ETH + WETH combined)
      ethInFloat,
      ethOutFloat,

      // PnL aggregates (ETH)
      realizedWeth: totalRealizedE,
      unrealizedWeth: totalUnrealizedE,
      totalPnlWeth: totalPnlE,
      pnlPct,

      // USD
      airdropsUsd: totalAirdropUsd,
      holdingsUsd: totalHoldingsUsd
    },
    tokens: perToken,
    derived: {
      open: openPositions,
      airdrops: airdropsFlat,
      nfts: nftDrops,
      best,
      worst
    }
  };
}

// ---------- Public API with caching + Worker/Queue exports ----------
const bullRedis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
export const pnlQueueName = 'tabs_pnl';
export const pnlQueue = new Queue(pnlQueueName, { connection: bullRedis });

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
    await setJSON(key, data, 120); // 2 min cache
    return data;
  });
}

// Worker to recompute on demand
new Worker(
  pnlQueueName,
  async (job) => {
    const { wallet, window } = job.data || {};
    console.log('[PNL] job received', wallet, window);
    const res = await refreshPnl(String(wallet||''), String(window||'30d'));
    console.log('[PNL] job OK');
    return res;
  },
  { connection: bullRedis }
);