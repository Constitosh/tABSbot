// src/pnlWorker.js
// Wallet PnL for Abstract chain (ETH + WETH) with robust trade pairing.
// - Pairs token buys/sells with ETH/WETH legs by: same-tx → same-block → near-block (±2 blocks)
// - Handles Moonshot bonding & proxy/routers (known addresses), plus generic router flows
// - ETH totals (in/out) count ONLY matched trade legs (not generic transfers)
// - Realized PnL (average-cost) drives Top Profits / Top Losses (no MTM there)
// - Open positions = current holdings; we expose usdValueRemaining so you can hide <$1 in the renderer
// - Adds NFT airdrops (collection + qty) via account.tokennfttx
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

const WETH = '0x3439153eb7af838ad19d56e1571fbd09333c2809'.toLowerCase();

// Router/forwarders used by Moonshot & TG bots (expandable)
const KNOWN_ROUTERS = new Set([
  '0x0d6848e39114abe69054407452b8aab82f8a44ba'.toLowerCase(), // Moonshot router
  '0x1c4ae91dfa56e49fca849ede553759e1f5f04d9f'.toLowerCase(), // TG proxy/forwarder
]);

// ---------- HTTP client & throttle ----------
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
function esURL(params) { const u=new URL(ES_BASE); Object.entries({ chainid: ES_CHAIN, apikey: ES_KEY, ...params }).forEach(([k,v])=>u.searchParams.set(k,String(v))); return u.toString(); }
async function esGET(params, { logOnce=false, tag='' }={}) {
  if (logOnce) console.log(`[ESV2] ${tag} ${esURL(params)}`);
  await throttleES();
  const maxAttempts = 3;
  for (let a=1; a<=maxAttempts; a++) {
    try {
      const { data } = await httpES.get('', esParams(params));
      if (data?.status === '1') return data.result;
      const msg = data?.result || data?.message || 'Unknown Etherscan error';
      if (a === maxAttempts) throw new Error(`Etherscan v2 error: ${msg}`);
    } catch (e) { if (a === maxAttempts) throw e; }
    await new Promise(r => setTimeout(r, 400*a));
  }
}

// ---------- Dexscreener quotes ----------
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
    }, { logOnce: page===1, tag:'[PNL tokentx]' });

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
    }, { logOnce: page===1, tag:'[PNL txlist]' });

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
async function getEthBalance(wallet) {
  try {
    const r = await esGET({ module: 'account', action: 'balance', address: wallet, tag: 'latest' }, { tag:'[balance]' });
    const s = typeof r === 'string' ? r : (r?.result || '0');
    return s;
  } catch { return '0'; }
}
// NFTs (for airdrops listing)
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
    }, { logOnce: page===1, tag:'[PNL nfttx]' });

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

// ---------- Math ----------
const toBig = (x) => BigInt(String(x));
const add   = (a,b) => (a||0n) + (b||0n);

// ---------- Core compute ----------
async function computePnL(wallet, { sinceTs=0 }) {
  wallet = wallet.toLowerCase();

  // Pull histories & ETH balance
  const [erc20, normal, nfttx, ethBalWeiStr] = await Promise.all([
    getWalletERC20Txs(wallet, { fromTs: sinceTs }),
    getWalletNormalTxs(wallet, { fromTs: sinceTs }),
    getWalletNFTTxs(wallet, { fromTs: sinceTs }),
    getEthBalance(wallet),
  ]);
  const ethBalanceFloat = Number(ethBalWeiStr) / 1e18;

  // Build ETH/WETH deltas per tx hash and per block, plus nearby window map
  const wethDeltaByHash = new Map(); // hash -> +in/-out (wei)
  const ethDeltaByHash  = new Map(); // hash -> +in/-out (wei)
  const blockEthNet     = new Map(); // blockNumber -> net +in/-out (wei)
  const blockWethNet    = new Map(); // blockNumber -> net +in/-out (wei)

  // Also index block → {hashes[]}, and a sliding window of blocks for near-block pairing
  const blocksSeen = new Set();

  // Native ETH deltas (+ block net)
  for (const tx of normal) {
    const hash = String(tx.hash);
    const bn   = Number(tx.blockNumber || 0);
    blocksSeen.add(bn);
    const from = String(tx.from || '').toLowerCase();
    const to   = String(tx.to   || '').toLowerCase();
    const val  = toBig(tx.value || '0');

    let d = 0n;
    if (to === wallet && val > 0n) d = val;
    else if (from === wallet && val > 0n) d = -val;

    if (d !== 0n) {
      ethDeltaByHash.set(hash, add(ethDeltaByHash.get(hash), d));
      blockEthNet.set(bn, add(blockEthNet.get(bn), d));
    }
  }

  // Group ERC20 by token and compute WETH deltas + block net
  const tokenTxsByToken = new Map(); // tokenCA -> tx[]
  for (const r of erc20) {
    const hash  = String(r.hash);
    const bn    = Number(r.blockNumber || 0);
    blocksSeen.add(bn);
    const token = String(r.contractAddress || '').toLowerCase();
    const to    = String(r.to   || '').toLowerCase();
    const from  = String(r.from || '').toLowerCase();
    const v     = toBig(r.value || '0');

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

  // For near-block pairing, build quick access map
  const allBlockNums = [...blocksSeen].sort((a,b)=>a-b);
  const blockIndex = new Map(allBlockNums.map((bn, i) => [bn, i]));

  const perToken = [];
  // Totals counting **only matched trade legs**
  let tradedEthInWei  = 0n; // ETH+WETH received from sells
  let tradedEthOutWei = 0n; // ETH+WETH spent on buys

  for (const [token, txs] of tokenTxsByToken.entries()) {
    txs.sort((a,b) =>
      (Number(a.timeStamp) - Number(b.timeStamp)) ||
      (Number(a.blockNumber) - Number(b.blockNumber)) ||
      (Number(a.transactionIndex||0) - Number(b.transactionIndex||0)) ||
      (Number(a.logIndex||0) - Number(b.logIndex||0))
    );

    const { priceUsd, priceWeth } = await getQuotes(token);

    let qty = 0n;              // token units currently held
    let costWeth = 0n;         // cost basis for remaining (wei)
    let realizedWeth = 0n;     // realized PnL (wei)
    let buys = 0n, sells = 0n; // token units

    const tokenDecimals = Math.max(0, Number(txs[0]?.tokenDecimal || 18));
    const scale = 10n ** BigInt(tokenDecimals);

    const airdrops = [];

    // For near-block pairing, maintain small queues of unmatched token moves
    const unmatchedBuys  = []; // {bn, hash, amt}
    const unmatchedSells = []; // {bn, hash, amt}

    for (const r of txs) {
      const hash   = String(r.hash);
      const bn     = Number(r.blockNumber || 0);
      const to     = String(r.to   || '').toLowerCase();
      const from   = String(r.from || '').toLowerCase();
      const amt    = toBig(r.value || '0');

      const wethHash = wethDeltaByHash.get(hash) || 0n;
      const ethHash  = ethDeltaByHash.get(hash)  || 0n;
      const paidWei  = (ethHash  < 0n ? -ethHash  : 0n) + (wethHash < 0n ? -wethHash : 0n);
      const recvWei  = (ethHash  > 0n ?  ethHash  : 0n) + (wethHash > 0n ?  wethHash : 0n);

      // BUY: wallet receives token + either pays ETH/WETH in same tx OR comes from token/known router
      if (to === wallet) {
        if (paidWei > 0n) {
          // straight buy, same tx
          buys += amt; qty += amt; costWeth += paidWei;
          tradedEthOutWei += paidWei;
          continue;
        }
        // Bonding or router-delivered (from==token or known router)
        if (from === token || KNOWN_ROUTERS.has(from)) {
          // try to find settlement: same block net out
          let settlement = (add(blockEthNet.get(bn), blockWethNet.get(bn)) || 0n);
          if (settlement < 0n) {
            const paid = -settlement;
            buys += amt; qty += amt; costWeth += paid;
            tradedEthOutWei += paid;
            continue;
          }
          // search near blocks (±2)
          const idx = blockIndex.get(bn) ?? -1;
          let paid = 0n;
          if (idx >= 0) {
            for (let di of [1,2]) {
              const left  = allBlockNums[idx-di];
              const right = allBlockNums[idx+di];
              if (left != null) {
                const net = (add(blockEthNet.get(left), blockWethNet.get(left)) || 0n);
                if (net < 0n) { paid = -net; break; }
              }
              if (right != null) {
                const net = (add(blockEthNet.get(right), blockWethNet.get(right)) || 0n);
                if (net < 0n) { paid = -net; break; }
              }
            }
          }
          if (paid > 0n) {
            buys += amt; qty += amt; costWeth += paid;
            tradedEthOutWei += paid;
            continue;
          }
          // no settlement seen -> queue to try matching later (worst case mark as airdrop)
          unmatchedBuys.push({ bn, hash, amt });
          continue;
        }

        // No clear cost leg -> queue buy
        unmatchedBuys.push({ bn, hash, amt });
        continue;
      }

      // SELL: wallet sends token
      if (from === wallet) {
        if (recvWei > 0n) {
          // straight sell, same tx
          sells += amt;
          const avgCostWeiPerUnit = qty > 0n ? (costWeth * 1_000_000_000_000_000_000n) / qty : 0n;
          const amtUsed = amt > qty ? qty : amt;
          const costOfSold = (avgCostWeiPerUnit * amtUsed) / 1_000_000_000_000_000_000n;

          realizedWeth += (recvWei - costOfSold);
          tradedEthInWei += recvWei;

          const newQty = qty > amtUsed ? (qty - amtUsed) : 0n;
          costWeth = newQty > 0n ? (avgCostWeiPerUnit * newQty) / 1_000_000_000_000_000_000n : 0n;
          qty = newQty;
          continue;
        }

        // Router/proxy out: try block/near-block settlement
        if (KNOWN_ROUTERS.has(to) || to === token) {
          let inflow = (add(blockEthNet.get(bn), blockWethNet.get(bn)) || 0n);
          if (inflow > 0n) {
            sells += amt;
            const avgCostWeiPerUnit = qty > 0n ? (costWeth * 1_000_000_000_000_000_000n) / qty : 0n;
            const amtUsed = amt > qty ? qty : amt;
            const costOfSold = (avgCostWeiPerUnit * amtUsed) / 1_000_000_000_000_000_000n;

            realizedWeth += (inflow - costOfSold);
            tradedEthInWei += inflow;

            const newQty = qty > amtUsed ? (qty - amtUsed) : 0n;
            costWeth = newQty > 0n ? (avgCostWeiPerUnit * newQty) / 1_000_000_000_000_000_000n : 0n;
            qty = newQty;
            continue;
          }
          // search near blocks (±2)
          const idx = blockIndex.get(bn) ?? -1;
          let recv = 0n;
          if (idx >= 0) {
            for (let di of [1,2]) {
              const left  = allBlockNums[idx-di];
              const right = allBlockNums[idx+di];
              if (left != null) {
                const net = (add(blockEthNet.get(left), blockWethNet.get(left)) || 0n);
                if (net > 0n) { recv = net; break; }
              }
              if (right != null) {
                const net = (add(blockEthNet.get(right), blockWethNet.get(right)) || 0n);
                if (net > 0n) { recv = net; break; }
              }
            }
          }
          if (recv > 0n) {
            sells += amt;
            const avgCostWeiPerUnit = qty > 0n ? (costWeth * 1_000_000_000_000_000_000n) / qty : 0n;
            const amtUsed = amt > qty ? qty : amt;
            const costOfSold = (avgCostWeiPerUnit * amtUsed) / 1_000_000_000_000_000_000n;

            realizedWeth += (recv - costOfSold);
            tradedEthInWei += recv;

            const newQty = qty > amtUsed ? (qty - amtUsed) : 0n;
            costWeth = newQty > 0n ? (avgCostWeiPerUnit * newQty) / 1_000_000_000_000_000_000n : 0n;
            qty = newQty;
            continue;
          }
          // otherwise queue
          unmatchedSells.push({ bn, hash, amt });
          continue;
        }

        // No clear proceed leg -> queue sell (may be gift/internal)
        unmatchedSells.push({ bn, hash, amt });
        continue;
      }
    }

    // Attempt near-block cross matching for leftover unmatched moves
    // Heuristic: match earliest buy with nearest ETH/WETH net-out block in ±2; same for sells with net-in.
    for (const u of unmatchedBuys) {
      const { bn, amt } = u;
      const idx = blockIndex.get(bn) ?? -1;
      let paid = 0n;
      if (idx >= 0) {
        for (let di of [0,1,2]) {
          for (const side of [-1, +1]) {
            const pos = idx + side*di;
            if (pos < 0 || pos >= allBlockNums.length) continue;
            const b = allBlockNums[pos];
            const net = (add(blockEthNet.get(b), blockWethNet.get(b)) || 0n);
            if (net < 0n) { paid = -net; break; }
          }
          if (paid > 0n) break;
        }
      }
      if (paid > 0n) {
        buys += amt; qty += amt; costWeth += paid;
        tradedEthOutWei += paid;
      } else {
        // still no settlement → treat as airdrop
        airdrops.push({ amount: amt });
        qty += amt; // zero cost
      }
    }

    for (const u of unmatchedSells) {
      const { bn, amt } = u;
      const idx = blockIndex.get(bn) ?? -1;
      let recv = 0n;
      if (idx >= 0) {
        for (let di of [0,1,2]) {
          for (const side of [-1, +1]) {
            const pos = idx + side*di;
            if (pos < 0 || pos >= allBlockNums.length) continue;
            const b = allBlockNums[pos];
            const net = (add(blockEthNet.get(b), blockWethNet.get(b)) || 0n);
            if (net > 0n) { recv = net; break; }
          }
          if (recv > 0n) break;
        }
      }
      if (recv > 0n) {
        sells += amt;
        const avgCostWeiPerUnit = qty > 0n ? (costWeth * 1_000_000_000_000_000_000n) / qty : 0n;
        const amtUsed = amt > qty ? qty : amt;
        const costOfSold = (avgCostWeiPerUnit * amtUsed) / 1_000_000_000_000_000_000n;

        realizedWeth += (recv - costOfSold);
        tradedEthInWei += recv;

        const newQty = qty > amtUsed ? (qty - amtUsed) : 0n;
        costWeth = newQty > 0n ? (avgCostWeiPerUnit * newQty) / 1_000_000_000_000_000_000n : 0n;
        qty = newQty;
      } else {
        // treat as gift/internal out: reduce qty + cost basis proportionally
        if (qty > 0n) {
          const avgCostWeiPerUnit = (costWeth * 1_000_000_000_000_000_000n) / (qty || 1n);
          const amtUsed = amt > qty ? qty : amt;
          const costReduction = (avgCostWeiPerUnit * amtUsed) / 1_000_000_000_000_000_000n;
          qty -= amtUsed;
          costWeth = costWeth > costReduction ? (costWeth - costReduction) : 0n;
        }
      }
    }

    // Mark-to-market (used only for totals / open positions USD)
    const qtyFloat   = Number(qty) / Number(scale || 1n);
    const invCostW   = Number(costWeth) / 1e18;
    const mtmW       = qtyFloat * Number(priceWeth || 0);
    const unrealW    = mtmW - invCostW;
    const usdValue   = qtyFloat * Number(priceUsd || 0);

    // Airdrops USD
    let adUnits = 0n;
    for (const a of airdrops) adUnits += a.amount;
    const adQty = Number(adUnits) / Number(scale || 1n);
    const adUsd = adQty * Number(priceUsd || 0);

    // Dust filter for *open* positions (<5 tokens), keep closed for realized stats
    const symUp = String(txs[0]?.tokenSymbol || '').toUpperCase();
    const isEthLike = (symUp === 'ETH') || (symUp === 'WETH') || (token === WETH);
    const MIN_UNITS = 5n * (10n ** BigInt(tokenDecimals));
    const isOpen = qty > 0n;
    const isDustOpen = isOpen && !isEthLike && qty < MIN_UNITS;

    if (!isDustOpen) {
      perToken.push({
        token,
        symbol: txs[0]?.tokenSymbol || '',
        decimals: tokenDecimals,

        buys: buys.toString(),
        sells: sells.toString(),
        remaining: qty.toString(),

        // realized & cost in WETH-wei → floats ETH
        realizedWeth: Number(realizedWeth) / 1e18,
        inventoryCostWeth: Number(costWeth) / 1e18,

        // quotes
        priceUsd: Number(priceUsd || 0),
        priceWeth: Number(priceWeth || 0),

        // for totals/open positions only; not used in top profits/losses
        unrealizedWeth: unrealW,
        usdValueRemaining: usdValue,

        airdrops: {
          count: airdrops.length,
          units: adUnits.toString(),
          estUsd: adUsd
        }
      });
    }
  }

  // NFT airdrops (collection + quantity inbound where no matching ETH/WETH)
  // (We simply list inbound NFT transfers to wallet)
  const nftDropsMap = new Map(); // key: contract -> { collection, count }
  for (const n of nfttx) {
    const to = String(n.to || '').toLowerCase();
    if (to !== wallet) continue;
    const key = String(n.contractAddress || '').toLowerCase();
    const collection = n.tokenName || n.tokenSymbol || key.slice(0,10);
    const prev = nftDropsMap.get(key) || { collection, count: 0 };
    prev.count += 1;
    nftDropsMap.set(key, prev);
  }
  const nftDrops = [...nftDropsMap.values()].map(x => ({ collection: x.collection, count: x.count }));

  // Totals across tokens
  let totalRealizedWeth   = 0;
  let totalUnrealizedWeth = 0;
  let totalAirdropUsd     = 0;
  let totalHoldingsUsd    = 0;

  for (const r of perToken) {
    totalRealizedWeth   += Number(r.realizedWeth) || 0;
    totalUnrealizedWeth += Number(r.unrealizedWeth) || 0;
    totalAirdropUsd     += Number(r.airdrops?.estUsd || 0);
    totalHoldingsUsd    += Number(r.usdValueRemaining || 0);
  }

  // IMPORTANT: ETH totals shown in UI should reflect **trade legs only**
  const ethInFloat  = Number(tradedEthInWei)  / 1e18;
  const ethOutFloat = Number(tradedEthOutWei) / 1e18;

  const totalPnlWeth = totalRealizedWeth + totalUnrealizedWeth;
  const spentBase    = ethOutFloat; // denominator for PnL% — only what you actually spent on buys
  const pnlPct       = spentBase > 0 ? (totalPnlWeth / spentBase) * 100 : 0;

  // Derived sets
  const openPositions = perToken.filter(t => Number(t.remaining) > 0);
  const airdropsFlat  = perToken
    .filter(t => (t.airdrops?.count || 0) > 0)
    .map(t => ({ token: t.token, symbol: t.symbol, decimals: t.decimals, units: t.airdrops.units, estUsd: t.airdrops.estUsd }));

  // Realized-only leaders (CLOSED or partially realized). Sort by realized only.
  const realizedOnly = perToken.filter(t => Math.abs(Number(t.realizedWeth) || 0) > 0);
  const best  = [...realizedOnly].sort((a,b)=> (Number(b.realizedWeth)||0) - (Number(a.realizedWeth)||0)).slice(0, 15);
  const worst = [...realizedOnly].sort((a,b)=> (Number(a.realizedWeth)||0) - (Number(b.realizedWeth)||0)).slice(0, 15);

  return {
    wallet,
    sinceTs,
    totals: {
      // Wallet balance (native ETH)
      ethBalance: ethBalanceFloat, // float

      // Trade-only ETH flows (combined ETH+WETH legs that were matched to token trades)
      ethInFloat,
      ethOutFloat,

      // PnL aggregates (ETH)
      realizedWeth: totalRealizedWeth,
      unrealizedWeth: totalUnrealizedWeth,
      totalPnlWeth,
      pnlPct,

      // USD views
      airdropsUsd: totalAirdropUsd,
      holdingsUsd: totalHoldingsUsd
    },
    tokens: perToken,
    derived: {
      open: openPositions,
      airdrops: airdropsFlat,
      nfts: nftDrops,      // NEW: [{ collection, count }]
      best,                // realized-only, positive first
      worst                // realized-only, negative first
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