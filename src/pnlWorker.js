// src/pnlWorker.js
// PnL engine for /pnl <wallet>
// - Unifies ETH + WETH
// - Per-tx join: token in/out ↔ ETH(+WETH) out/in (same txhash), with a safe fallback
// - Average price method (moving average / single bucket) for realized PnL
// - Dust (<5 tokens) => treat as fully closed
// - Open positions show token holdings + $ value only (no ETH on that page)
// - Etherscan v2 (5 rps throttle). Dexscreener only for pricing of open positions + quick labels
//
// Exports:
//   export async function refreshPnl(wallet, window = '30d')
//
// Used by: renderers_pnl.js

import './configEnv.js';
import axios from 'axios';

// ---------- Config ----------

// Etherscan V2 (Abstract)
const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
const ES_CHAIN = process.env.ETHERSCAN_CHAIN_ID || '2741'; // Abstract chain-id

if (!ES_KEY) console.warn('[PNL] ETHERSCAN_API_KEY is missing — set it in env');

const httpES = axios.create({ baseURL: ES_BASE, timeout: 45_000 });

// 5 calls/sec max (200ms per call)
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
async function esGET(params, { tag = '' } = {}) {
  await throttleES();
  const maxAttempts = 3;
  for (let a = 1; a <= maxAttempts; a++) {
    try {
      const { data } = await httpES.get('', esParams(params));
      if (data?.status === '1') return data.result;
      const msg = data?.result || data?.message || 'ES v2 unknown error';
      if (a === maxAttempts) throw new Error(msg);
    } catch (e) {
      if (a === maxAttempts) throw e;
    }
    await new Promise(r => setTimeout(r, 300 * a));
  }
}

// Dexscreener (for pricing & names)
const httpDS = axios.create({ timeout: 15_000 });

// If you know Abstract WETH addresses, list them here or via ENV (comma-separated)
const WETH_SET = new Set(
  String(process.env.PNL_WETH_ADDRESSES || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);

// Also treat tokenSymbol === 'WETH' as WETH unless explicitly disabled
const USE_SYMBOL_DETECT_WETH = true;

// Dust threshold: < 5 tokens considered "closed"
const DUST_THRESHOLD = 5n;

// ---------- Helpers ----------
const toBig = (x) => BigInt(String(x));
const ONE_E18 = 10n ** 18n;

function shortAddr(a) {
  if (!a) return '';
  const s = String(a);
  return s.slice(0, 6) + '…' + s.slice(-4);
}
function round4(x) {
  if (!Number.isFinite(x)) return '0.0000';
  return (Math.round(x * 1e4) / 1e4).toFixed(4);
}
function kfmt(num) {
  // 10000 -> "10k", 135450 -> "135.45k", 3340000 -> "3.34m"
  const n = Number(num);
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) < 10_000) return String(Math.round(n * 100) / 100);
  if (Math.abs(n) < 1_000_000) return (Math.round(n / 10) / 100).toFixed(2) + 'k';
  if (Math.abs(n) < 1_000_000_000) return (Math.round(n / 10_000) / 100).toFixed(2) + 'm';
  return (Math.round(n / 10_000_000) / 100).toFixed(2) + 'b';
}
function parseWindow(win) {
  const now = Math.floor(Date.now() / 1000);
  if (win === '24h') return now - 24 * 3600;
  if (win === '7d')  return now - 7  * 24 * 3600;
  if (win === '30d') return now - 30 * 24 * 3600;
  if (win === '90d') return now - 90 * 24 * 3600;
  return 0; // 'all'
}

function bnToNum(raw, decimals) {
  try {
    const bi = toBig(raw);
    const d  = BigInt(Math.max(0, Number(decimals || 18)));
    if (d === 0n) return Number(bi);
    const base = 10n ** d;
    const whole = bi / base;
    const frac  = Number(bi % base) / Number(base);
    return Number(whole) + frac;
  } catch {
    return 0;
  }
}

// ---------- Fetch account activity ----------
async function getTokentxByAddress(address, { pageSize = 100, maxPages = 100 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await esGET({
      module: 'account',
      action: 'tokentx',
      address,
      page,
      offset: pageSize,
      startblock: 0,
      endblock: 9_223_372_036,
      sort: 'asc'
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}
async function getTxList(address, { pageSize = 100, maxPages = 100 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await esGET({
      module: 'account',
      action: 'txlist',
      address,
      page,
      offset: pageSize,
      startblock: 0,
      endblock: 9_223_372_036,
      sort: 'asc'
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}
async function getInternalByAddress(address, { pageSize = 100, maxPages = 100 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await esGET({
      module: 'account',
      action: 'txlistinternal',
      address,
      page,
      offset: pageSize,
      startblock: 0,
      endblock: 9_223_372_036,
      sort: 'asc'
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}

// ---------- Dexscreener helpers ----------
async function getTokenPairsBulk(tokenAddresses /* array of 0x.. */) {
  // dexscreener lets multiple tokens: /latest/dex/tokens/<comma>
  const uniq = [...new Set(tokenAddresses.map(s => s.toLowerCase()))];
  if (!uniq.length) return {};
  const chunks = [];
  const out = {};
  for (let i = 0; i < uniq.length; i += 20) chunks.push(uniq.slice(i, i + 20)); // be kind
  for (const group of chunks) {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${group.join(',')}`;
    try {
      const { data } = await httpDS.get(url);
      const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
      // pick the best Abstract pair per token
      const best = {};
      for (const p of pairs) {
        if (String(p?.chainId) !== 'abstract') continue;
        const ca = String(p?.baseToken?.address || '').toLowerCase();
        if (!ca) continue;
        const score = Number(p?.liquidity?.usd || 0) + Number(p?.volume?.h24 || 0);
        if (!best[ca] || score > best[ca].score) {
          best[ca] = {
            score,
            symbol: p?.baseToken?.symbol || '',
            name: p?.baseToken?.name || '',
            priceUsd: Number(p?.priceUsd || 0),
          };
        }
      }
      for (const [ca, v] of Object.entries(best)) out[ca] = v;
    } catch {
      // ignore this chunk
    }
  }
  return out; // { ca -> {symbol,name,priceUsd} }
}

// ---------- Tx join + trade extraction ----------
function detectWeth(contractAddress, tokenSymbol) {
  const ca = String(contractAddress || '').toLowerCase();
  if (WETH_SET.has(ca)) return true;
  if (USE_SYMBOL_DETECT_WETH && String(tokenSymbol).toUpperCase() === 'WETH') return true;
  return false;
}

export async function refreshPnl(wallet, window = '30d') {
  const acct = String(wallet || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(acct)) throw new Error('Bad wallet');

  const sinceTs = parseWindow(window);

  // 1) Pull account activity
  const [tokentx, normal, internal] = await Promise.all([
    getTokentxByAddress(acct),
    getTxList(acct),
    getInternalByAddress(acct)
  ]);

  // Build per-hash envelope
  // txmap[hash] = {
  //   ts,
  //   ethInWei, ethOutWei,
  //   tokenDeltas: { [token]: { deltaRaw(bigint), decimals, symbol, name } }
  // }
  const txmap = new Map();

  // normal ETH (top-level value)
  for (const t of normal) {
    const h = t.hash;
    const ts = Number(t.timeStamp || 0);
    const from = String(t.from || '').toLowerCase();
    const to   = String(t.to   || '').toLowerCase();
    const valWei = toBig(t.value || '0');

    let rec = txmap.get(h);
    if (!rec) txmap.set(h, rec = { ts, ethInWei: 0n, ethOutWei: 0n, tokenDeltas: {} });

    if (from === acct && valWei > 0n) rec.ethOutWei += valWei;
    if (to   === acct && valWei > 0n) rec.ethInWei  += valWei;
    if (!rec.ts) rec.ts = ts;
  }

  // internal ETH (router → wallet for sells, wallet → contract for buys, etc.)
  for (const i of internal) {
    const h = i.hash;
    const ts = Number(i.timeStamp || 0);
    const from = String(i.from || '').toLowerCase();
    const to   = String(i.to   || '').toLowerCase();
    const valWei = toBig(i.value || '0');

    let rec = txmap.get(h);
    if (!rec) txmap.set(h, rec = { ts, ethInWei: 0n, ethOutWei: 0n, tokenDeltas: {} });

    if (from === acct && valWei > 0n) rec.ethOutWei += valWei;
    if (to   === acct && valWei > 0n) rec.ethInWei  += valWei;
    if (!rec.ts) rec.ts = ts;
  }

  // token transfers (ERC20 + WETH unify)
  for (const ev of tokentx) {
    const h  = ev.hash;
    const ts = Number(ev.timeStamp || 0);
    const from = String(ev.from || '').toLowerCase();
    const to   = String(ev.to   || '').toLowerCase();
    const ca   = String(ev.contractAddress || '').toLowerCase();
    const sym  = String(ev.tokenSymbol || '');
    const name = String(ev.tokenName || '');
    const dec  = Number(ev.tokenDecimal || 18);
    const raw  = toBig(ev.value || '0');
    if (raw === 0n) continue;

    let rec = txmap.get(h);
    if (!rec) txmap.set(h, rec = { ts, ethInWei: 0n, ethOutWei: 0n, tokenDeltas: {} });

    // WETH as ETH: treat wallet WETH in/out as ethIn/ethOut (unified)
    const isW = detectWeth(ca, sym);
    if (isW) {
      // wallet receiving WETH == ETH in
      if (to === acct)  rec.ethInWei  += raw * (ONE_E18 / (10n ** BigInt(dec)));
      if (from === acct) rec.ethOutWei += raw * (ONE_E18 / (10n ** BigInt(dec)));
      if (!rec.ts) rec.ts = ts;
      continue;
    }

    // non-WETH token delta
    if (!rec.tokenDeltas[ca]) rec.tokenDeltas[ca] = { deltaRaw: 0n, decimals: dec, symbol: sym, name };
    // Incoming tokens = buy(+) ; Outgoing tokens = sell(-)
    if (to === acct)   rec.tokenDeltas[ca].deltaRaw += raw;
    if (from === acct) rec.tokenDeltas[ca].deltaRaw -= raw;
    if (!rec.ts) rec.ts = ts;
  }

  // 2) Extract trades by txhash (only hashes that have exactly ONE non-WETH token involved)
  const trades = []; // { ts, hash, token, tokenDeltaRaw, decimals, symbol, ethInWei, ethOutWei }
  for (const [hash, rec] of txmap.entries()) {
    if (sinceTs && rec.ts && rec.ts < sinceTs) continue;
    const tokens = Object.keys(rec.tokenDeltas);
    const nonZero = tokens.filter(t => txmap.get(hash).tokenDeltas[t].deltaRaw !== 0n);
    if (nonZero.length !== 1) continue; // skip multi-token or no-token txs
    const token = nonZero[0];
    const info = rec.tokenDeltas[token];
    trades.push({
      hash,
      ts: rec.ts || 0,
      token,
      symbol: info.symbol || '',
      decimals: info.decimals || 18,
      tokenDeltaRaw: info.deltaRaw, // >0 buy, <0 sell
      ethInWei:  rec.ethInWei,
      ethOutWei: rec.ethOutWei,
    });
  }

  // 3) Per-token rollup with average-cost accounting
  // positions[token] = {
  //   symbol, decimals,
  //   qtyBoughtRaw, qtySoldRaw,
  //   ethSpentWei,  ethRecvWei,
  //   realizedWei,
  // }
  const positions = new Map();

  function posFor(token, symbol, decimals) {
    let p = positions.get(token);
    if (!p) {
      p = {
        token,
        symbol: symbol || '',
        decimals: decimals || 18,
        qtyBoughtRaw: 0n,
        qtySoldRaw:   0n,
        ethSpentWei:  0n,  // only for buys
        ethRecvWei:   0n,  // only for sells
        realizedWei:  0n
      };
      positions.set(token, p);
    }
    return p;
  }

  // Sum per tx: allocate ETH leg entirely to the single token in that tx
  for (const tr of trades) {
    const p = posFor(tr.token, tr.symbol, tr.decimals);

    if (tr.tokenDeltaRaw > 0n) {
      // BUY: need ETH out (or WETH out) as cost; if zero, it's likely a true airdrop/mint (no cost)
      const ethSpent = tr.ethOutWei > 0n ? tr.ethOutWei : 0n;
      p.qtyBoughtRaw += tr.tokenDeltaRaw;
      p.ethSpentWei  += ethSpent;
    } else {
      // SELL: need ETH in as proceeds
      const qtySold = -tr.tokenDeltaRaw;
      const ethIn   = tr.ethInWei > 0n ? tr.ethInWei : 0n;
      p.qtySoldRaw += qtySold;
      p.ethRecvWei += ethIn;
    }
  }

  // Realized PnL using average cost
  for (const p of positions.values()) {
    const bought = p.qtyBoughtRaw;
    const sold   = p.qtySoldRaw;
    const costWei = p.ethSpentWei;

    if (bought > 0n && sold > 0n) {
      const avgCostPerTokenWei = costWei === 0n ? 0n : (costWei * ONE_E18) / bought; // scaled (per 1 token in wei terms * 1e18)
      // cost basis of sold qty = avg * sold
      const cbSoldWei = (avgCostPerTokenWei * sold) / ONE_E18; // back to wei
      const proceedsWei = p.ethRecvWei;
      p.realizedWei = proceedsWei - cbSoldWei;
    } else {
      p.realizedWei = 0n;
    }
  }

  // 4) Open positions & airdrops
  // open: tokens held > 5; dust <=5 -> treat as closed
  const tokenList = [...positions.values()];
  const openTokens = [];
  const realizedItems = [];
  const priceNeeded = [];

  for (const p of tokenList) {
    const heldRaw = p.qtyBoughtRaw - p.qtySoldRaw;
    const heldBig = heldRaw > 0n ? heldRaw : 0n;

    // classify realized item (closed if held <= DUST)
    const closed = heldBig <= DUST_THRESHOLD;
    const boughtNum = bnToNum(p.qtyBoughtRaw, p.decimals);
    const soldNum   = bnToNum(p.qtySoldRaw,   p.decimals);

    const avgBuy = (p.qtyBoughtRaw > 0n && p.ethSpentWei > 0n)
      ? Number(p.ethSpentWei) / 1e18 / boughtNum
      : 0;

    const realizedEth = Number(p.realizedWei) / 1e18;
    const realizedPct = (avgBuy > 0 && soldNum > 0)
      ? (Number(p.ethRecvWei) / 1e18 - avgBuy * soldNum) / (avgBuy * soldNum) * 100
      : 0;

    if (closed) {
      realizedItems.push({
        token: p.token,
        symbol: p.symbol,
        decimals: p.decimals,
        buyEth: Number(p.ethSpentWei) / 1e18,
        sellEth: Number(p.ethRecvWei) / 1e18,
        realizedEth,
        realizedPct
      });
    } else {
      // Need $ price for open pos
      const heldNum = bnToNum(heldBig, p.decimals);
      openTokens.push({
        token: p.token,
        symbol: p.symbol,
        decimals: p.decimals,
        heldNum,
        avgBuyEth: avgBuy
      });
      priceNeeded.push(p.token);
    }
  }

  // 5) Price lookup for open positions (+ symbols)
  const priceMap = await getTokenPairsBulk(priceNeeded);

  // fill open with USD + implied ETH value (via priceUsd / spot ethUsd)
  // We don’t have ETH/USD spot here — Dexscreener priceUsd is already per token.
  let holdingsUsd = 0;
  const openEnriched = openTokens.map(op => {
    const info = priceMap[op.token?.toLowerCase()] || {};
    const usd = (Number(info.priceUsd || 0) * op.heldNum) || 0;
    holdingsUsd += usd;
    return {
      ...op,
      name: info.name || '',
      symbol: info.symbol || op.symbol || '',
      usdNow: usd
    };
  });

  // 6) Airdrops: token/NFT received with no ethOut in that tx
  // Use trade list we skipped (zero token? No) + original tokentx to catch zero-cost token ins
  // We'll detect any txhash where wallet got tokens and no ETH/WETH out.
  const tokenAirdrops = {};
  for (const [hash, rec] of txmap.entries()) {
    if (sinceTs && rec.ts && rec.ts < sinceTs) continue;
    const tokens = Object.keys(rec.tokenDeltas);
    for (const ca of tokens) {
      const d = rec.tokenDeltas[ca];
      if (d.deltaRaw > 0n && rec.ethOutWei === 0n) {
        const key = ca.toLowerCase();
        if (!tokenAirdrops[key]) tokenAirdrops[key] = { ca: key, qtyRaw: 0n, decimals: d.decimals, symbol: d.symbol, name: d.name };
        tokenAirdrops[key].qtyRaw += d.deltaRaw;
      }
    }
  }
  // NFT airdrops: pull ERC721 via tokennfttx (cheaper to fetch all? do small pages)
  let nftDrops = [];
  try {
    // One pass of 200 events asc — enough for latest airdrops
    const res = await esGET({
      module: 'account',
      action: 'tokennfttx',
      address: acct,
      page: 1,
      offset: 200,
      startblock: 0,
      endblock: 9_223_372_036,
      sort: 'desc'
    });
    if (Array.isArray(res)) {
      const seen = new Map(); // contract -> count received (only when from != acct)
      for (const ev of res) {
        const ts = Number(ev.timeStamp || 0);
        if (sinceTs && ts < sinceTs) continue;
        const from = String(ev.from || '').toLowerCase();
        const to   = String(ev.to   || '').toLowerCase();
        if (to !== acct) continue;
        // treat as airdrop if the paired tx had no ethOut
        const rec = txmap.get(ev.hash);
        if (rec && rec.ethOutWei === 0n) {
          const key = String(ev.contractAddress || '').toLowerCase();
          const name = String(ev.tokenName || '');
          seen.set(key, {
            contract: key,
            name,
            qty: (seen.get(key)?.qty || 0) + 1
          });
        }
      }
      nftDrops = [...seen.values()];
    }
  } catch {}

  // 7) Totals (ONLY from trades we recognized)
  let ETH_IN  = 0;
  let ETH_OUT = 0;
  for (const tr of trades) {
    if (tr.tokenDeltaRaw > 0n) { // buy
      ETH_OUT += Number(tr.ethOutWei) / 1e18;
    } else if (tr.tokenDeltaRaw < 0n) { // sell
      ETH_IN += Number(tr.ethInWei) / 1e18;
    }
  }

  // realized summary
  const realizedTotal = tokenList.reduce((acc, p) => acc + (Number(p.realizedWei) / 1e18), 0);

  // Sort realized for top 3
  const realizedPos = realizedItems
    .filter(x => x.realizedEth > 0)
    .sort((a,b) => b.realizedPct - a.realizedPct);

  const realizedNeg = realizedItems
    .filter(x => x.realizedEth < 0)
    .sort((a,b) => a.realizedPct - b.realizedPct); // most negative first

  // Make full lists (profits & losses) for deeper pages
  const fullProfits = realizedItems
    .filter(x => x.realizedEth > 0)
    .sort((a,b) => b.realizedPct - a.realizedPct);

  const fullLosses = realizedItems
    .filter(x => x.realizedEth < 0)
    .sort((a,b) => a.realizedPct - b.realizedPct);

  // “Unrealized”: value of open positions minus their cost basis portion
  // We only display $ value in Open Positions; for a simple ETH unrealized we approximate via avgBuy
  let unrealizedEth = 0;
  for (const op of openTokens) {
    const avgBuy = op.avgBuyEth || 0;
    // cost basis of current holding in ETH
    const cost = avgBuy * op.heldNum;
    // approximate ETH value via USD: priceUsd / ethUsd would be needed; we don’t fetch ethUsd here,
    // so we’ll keep unrealized in ETH as 0 and leave $ value in holdings only (per your spec).
  }

  // Airdrops $ (tokens only). We’ll price if we have DS info:
  let airdropsUsd = 0;
  for (const v of Object.values(tokenAirdrops)) {
    const info = priceMap[v.ca] || {};
    const qty = bnToNum(v.qtyRaw, v.decimals);
    airdropsUsd += Number(info.priceUsd || 0) * qty;
  }

  // Total PnL (ETH): realized only (since unrealized ETH we keep at 0 by design)
  const totalPnlEth = realizedTotal;
  // Total %: realized / (ETH_OUT on trades)
  const totalPct = (ETH_OUT > 0) ? (realizedTotal / ETH_OUT) * 100 : 0;

  return {
    wallet: acct,
    window,
    totals: {
      ethIn: +round4(ETH_IN),
      ethOut: +round4(ETH_OUT),
      realizedEth: +round4(realizedTotal),
      unrealizedEth: 0, // we don’t show ETH unrealized; open shows $ value
      holdingsUsd: Math.round(holdingsUsd * 100) / 100,
      airdropsUsd: Math.round(airdropsUsd * 100) / 100,
      totalEth: +round4(totalPnlEth),
      totalPct: +round4(totalPct),
    },
    topProfits: realizedPos.slice(0, 3),
    topLosses:  realizedNeg.slice(0, 3),
    fullProfits,
    fullLosses,
    open: openEnriched.sort((a,b) => b.usdNow - a.usdNow),
    airdrops: {
      tokens: Object.values(tokenAirdrops).map(v => ({
        ca: v.ca,
        symbol: v.symbol,
        name: v.name,
        qty: bnToNum(v.qtyRaw, v.decimals)
      })),
      nfts: nftDrops
    },
    // for renderer convenience
    _meta: {
      now: Date.now(),
    }
  };
}