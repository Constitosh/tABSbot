// src/pnlWorker.js
import './configEnv.js';
import axios from 'axios';
import { resolveChain } from './chains.js';

/* -------------------- Config -------------------- */

// Etherscan V2
const ES_BASE  = process.env.ETHERSCAN_BASE || 'https://api.etherscan.io/v2/api';
const ES_KEY   = process.env.ETHERSCAN_API_KEY;
if (!ES_KEY) console.warn('[PNL] ETHERSCAN_API_KEY missing');

const httpES = axios.create({ baseURL: ES_BASE, timeout: 45_000 });

// RPS throttle (default 5/sec)
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
function esParams(params, chain) {
  const chainId = chain?.etherscanChainId || '2741';
  return { params: { chainid: chainId, apikey: ES_KEY, ...params } };
}
async function esGET(params, chain) {
  await throttleES();
  const attempts = 3;
  for (let i = 1; i <= attempts; i++) {
    try {
      const { data } = await httpES.get('', esParams(params, chain));
      if (data?.status === '1') return data.result;
      const msg = data?.result || data?.message || 'Etherscan v2 error';
      if (i === attempts) throw new Error(msg);
    } catch (e) {
      if (i === attempts) throw e;
    }
    await new Promise(r => setTimeout(r, 250 * i));
  }
}

// Dexscreener (for price/name)
const httpDS = axios.create({ timeout: 15_000 });

// Optional Alchemy RPC (can be chain-specific via env if you want)
const ALCHEMY_RPC = process.env.ALCHEMY_RPC || '';

/* -------------------- Utils -------------------- */

const ONE_E18 = 10n ** 18n;
const toBig = (x) => BigInt(String(x));
function bnToNum(raw, decimals) {
  try {
    const bi = toBig(raw);
    const d  = BigInt(Math.max(0, Number(decimals || 18)));
    if (d === 0n) return Number(bi);
    const base = 10n ** d;
    const whole = bi / base;
    const frac  = Number(bi % base) / Number(base);
    return Number(whole) + frac;
  } catch { return 0; }
}
function round4(x){ return (Math.round(Number(x)*1e4)/1e4).toFixed(4); }
function round2(x){ return (Math.round(Number(x)*100)/100).toFixed(2); }
function parseWindow(win) {
  const now = Math.floor(Date.now() / 1000);
  if (win === '24h') return now - 24 * 3600;
  if (win === '7d')  return now - 7  * 24 * 3600;
  if (win === '30d') return now - 30 * 24 * 3600;
  if (win === '90d') return now - 90 * 24 * 3600;
  return 0; // 'all'
}

const WETH_SET = new Set(
  String(process.env.PNL_WETH_ADDRESSES || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);
const USE_SYMBOL_DETECT_WETH = true;
function detectWETH(addr, sym){
  if (WETH_SET.has(String(addr||'').toLowerCase())) return true;
  if (USE_SYMBOL_DETECT_WETH && String(sym||'').toUpperCase()==='WETH') return true;
  return false;
}
function isETHLikeSym(sym) {
  const s = String(sym || '').toUpperCase();
  return s === 'ETH' || s === 'WETH';
}
function isETHLikeAddr(addr) {
  if (!addr) return false;
  return WETH_SET.has(String(addr).toLowerCase());
}
function isETHLikeMeta(meta) {
  return isETHLikeAddr(meta?.token) || isETHLikeSym(meta?.symbol);
}

/* -------------------- Data pulls -------------------- */

async function getTxList(address, { pageSize = 100, maxPages = 100 } = {}, chain) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await esGET({
      module:'account', action:'txlist', address,
      page, offset:pageSize, startblock:0, endblock:9_223_372_036, sort:'asc'
    }, chain);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}
async function getInternalByAddress(address, { pageSize = 100, maxPages = 100 } = {}, chain) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await esGET({
      module:'account', action:'txlistinternal', address,
      page, offset:pageSize, startblock:0, endblock:9_223_372_036, sort:'asc'
    }, chain);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}
async function getTokentxByAddress(address, { pageSize = 100, maxPages = 100 } = {}, chain) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await esGET({
      module:'account', action:'tokentx', address,
      page, offset:pageSize, startblock:0, endblock:9_223_372_036, sort:'asc'
    }, chain);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < pageSize) break;
  }
  return out;
}
async function getNFTtx(address, { pageSize = 200 } = {}, chain) {
  const res = await esGET({
    module:'account', action:'tokennfttx', address,
    page:1, offset:pageSize, startblock:0, endblock:9_223_372_036, sort:'desc'
  }, chain);
  return Array.isArray(res) ? res : [];
}

// inside src/pnlWorker.js
async function getTokenPairsBulk(tokenCAs, chain) {
  const uniq = [...new Set(tokenCAs.map(s => s?.toLowerCase()).filter(Boolean))];
  const out = {};
  const slug = String(chain?.dsSlug || 'abstract').toLowerCase();

  for (let i = 0; i < uniq.length; i += 20) {
    const group = uniq.slice(i, i + 20);
    if (!group.length) continue;
    const url = `https://api.dexscreener.com/latest/dex/tokens/${group.join(',')}`;
    try {
      const { data } = await httpDS.get(url);
      const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
      const best = {};
      for (const p of pairs) {
        if (String(p?.chainId || '').toLowerCase() !== slug) continue;
        const ca = String(p?.baseToken?.address || '').toLowerCase();
        if (!ca) continue;
        const score = Number(p?.liquidity?.usd || 0) + Number(p?.volume?.h24 || 0);
        if (!best[ca] || score > best[ca].score) {
          best[ca] = {
            score,
            symbol: p?.baseToken?.symbol || '',
            name: p?.baseToken?.name || '',
            priceUsd: Number(p?.priceUsd || 0),
            priceNative: Number(p?.priceNative || 0),
          };
        }
      }
      for (const [k,v] of Object.entries(best)) out[k] = v;
    } catch {}
  }
  return out;
}

// Optional: full ERC20 balances via Alchemy RPC (can be chain-specific via env)
async function getAlchemyBalances(address) {
  if (!ALCHEMY_RPC) return [];
  try {
    const { data } = await axios.post(ALCHEMY_RPC, {
      id: 1, jsonrpc: "2.0", method: "alchemy_getTokenBalances",
      params: [address, "erc20"]
    }, { timeout: 20_000 });
    const list = data?.result?.tokenBalances || [];
    return list
      .filter(x => x?.tokenBalance && x.tokenBalance !== '0x0')
      .map(x => ({
        contractAddress: String(x.contractAddress || '').toLowerCase(),
        tokenBalanceHex: x.tokenBalance,
      }));
  } catch {
    return [];
  }
}

// Wallet ETH/native balance (balancemulti returns array)
async function getEthBalanceWei(address, chain) {
  try {
    const res = await esGET({ module:'account', action:'balancemulti', address, tag:'latest' }, chain);
    const first = (Array.isArray(res) ? res[0] : res) || {};
    return String(first.balance || '0');
  } catch {
    return '0';
  }
}
function weiToEthStr(wei) {
  try {
    const n = BigInt(String(wei || '0'));
    const int = n / ONE_E18;
    const frac = n % ONE_E18;
    let s = frac.toString().padStart(18, '0').replace(/0+$/, '');
    return s ? `${int.toString()}.${s}` : int.toString();
  } catch {
    return '0';
  }
}

/* -------------------- Core PnL -------------------- */

const DUST_THRESHOLD = 5n;

// Select traded token in a multi-delta tx
function chooseTradeToken(rec) {
  const keys = Object.keys(rec.tokenDeltas);
  if (!keys.length) return null;

  const items = keys
    .map(ca => ({ ca, ...rec.tokenDeltas[ca] }))
    .filter(x => x.deltaRaw !== 0n);
  if (!items.length) return null;

  const isBuy  = rec.ethOutWei > 0n && rec.ethInWei === 0n;
  const isSell = rec.ethInWei  > 0n && rec.ethOutWei === 0n;

  // dominant by |delta|
  let dominant = items.reduce((a,b)=>{
    const av = a.deltaRaw > 0n ? a.deltaRaw : -a.deltaRaw;
    const bv = b.deltaRaw > 0n ? b.deltaRaw : -b.deltaRaw;
    return av >= bv ? a : b;
  });

  if (isBuy) {
    if (dominant.deltaRaw < 0n) {
      const pos = items.filter(x => x.deltaRaw > 0n);
      if (pos.length) dominant = pos.reduce((a,b)=> a.deltaRaw > b.deltaRaw ? a : b);
    }
  } else if (isSell) {
    if (dominant.deltaRaw > 0n) {
      const neg = items.filter(x => x.deltaRaw < 0n);
      if (neg.length) dominant = neg.reduce((a,b)=> (-a.deltaRaw) > (-b.deltaRaw) ? a : b);
    }
  }

  return dominant;
}

export async function refreshPnl(wallet, window='30d', chainKey='tabs') {
  const chain = resolveChain(chainKey);

  const acct = String(wallet||'').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(acct)) throw new Error('Bad wallet');

  const sinceTs = parseWindow(window);

  // 1) Fetch txs
  const [normals, internals, tokentx] = await Promise.all([
    getTxList(acct, {}, chain),
    getInternalByAddress(acct, {}, chain),
    getTokentxByAddress(acct, {}, chain),
  ]);

  // 2) Build per-hash envelope
  const txmap = new Map(); // hash -> { ts, ethInWei, ethOutWei, tokenDeltas: {ca:{deltaRaw,decimals,symbol,name}} }

  // Normal ETH/native
  for (const t of normals) {
    const h = t.hash, ts = Number(t.timeStamp||0);
    const from = String(t.from||'').toLowerCase();
    const to   = String(t.to||'').toLowerCase();
    const valWei = toBig(t.value || '0');
    let rec = txmap.get(h); if (!rec) txmap.set(h, rec = { ts, ethInWei:0n, ethOutWei:0n, tokenDeltas:{} });
    if (from === acct && valWei > 0n) rec.ethOutWei += valWei;
    if (to   === acct && valWei > 0n) rec.ethInWei  += valWei;
    if (!rec.ts) rec.ts = ts;
  }
  // Internal ETH/native
  for (const t of internals) {
    const h = t.hash, ts = Number(t.timeStamp||0);
    const from = String(t.from||'').toLowerCase();
    const to   = String(t.to||'').toLowerCase();
    const valWei = toBig(t.value || '0');
    let rec = txmap.get(h); if (!rec) txmap.set(h, rec = { ts, ethInWei:0n, ethOutWei:0n, tokenDeltas:{} });
    if (from === acct && valWei > 0n) rec.ethOutWei += valWei;
    if (to   === acct && valWei > 0n) rec.ethInWei  += valWei;
    if (!rec.ts) rec.ts = ts;
  }
  // ERC20 (incl. WETH → map to ETH/native leg)
  for (const ev of tokentx) {
    const h  = ev.hash, ts = Number(ev.timeStamp||0);
    const from = String(ev.from||'').toLowerCase();
    const to   = String(ev.to||'').toLowerCase();
    const ca   = String(ev.contractAddress||'').toLowerCase();
    const sym  = String(ev.tokenSymbol||'');
    const name = String(ev.tokenName||'');
    const dec  = Number(ev.tokenDecimal||18);
    const raw  = toBig(ev.value || '0');
    if (raw === 0n) continue;

    let rec = txmap.get(h); if (!rec) txmap.set(h, rec = { ts, ethInWei:0n, ethOutWei:0n, tokenDeltas:{} });

    if (detectWETH(ca, sym)) {
      const wei = raw * (ONE_E18 / (10n ** BigInt(dec)));
      if (to === acct)   rec.ethInWei  += wei;
      if (from === acct) rec.ethOutWei += wei;
      if (!rec.ts) rec.ts = ts;
      continue;
    }

    if (!rec.tokenDeltas[ca]) rec.tokenDeltas[ca] = { deltaRaw:0n, decimals:dec, symbol:sym, name };
    if (to   === acct) rec.tokenDeltas[ca].deltaRaw += raw;
    if (from === acct) rec.tokenDeltas[ca].deltaRaw -= raw;
    if (!rec.ts) rec.ts = ts;
  }

  // 3) Extract trades with heuristic selection
  const trades = [];
  for (const [hash, rec] of txmap.entries()) {
    if (sinceTs && rec.ts && rec.ts < sinceTs) continue;
    const chosen = chooseTradeToken(rec);
    if (!chosen) continue;
    const hasEthLeg = (rec.ethInWei > 0n || rec.ethOutWei > 0n);
    if (!hasEthLeg) continue; // avoid pure transfers
    trades.push({
      hash,
      ts: rec.ts || 0,
      token: chosen.ca,
      symbol: chosen.symbol || '',
      decimals: chosen.decimals || 18,
      tokenDeltaRaw: chosen.deltaRaw, // >0 buy, <0 sell
      ethInWei:  rec.ethInWei,
      ethOutWei: rec.ethOutWei,
    });
  }

  // 4) Per-token rollup (average cost)
  const positions = new Map(); // token -> pos

  function posFor(token, symbol, decimals) {
    let p = positions.get(token);
    if (!p) {
      p = {
        token, symbol: symbol||'', decimals: decimals||18,
        qtyBoughtRaw:0n, qtySoldRaw:0n, ethSpentWei:0n, ethRecvWei:0n, realizedWei:0n
      };
      positions.set(token, p);
    }
    return p;
  }

  for (const tr of trades) {
    const p = posFor(tr.token, tr.symbol, tr.decimals);
    if (tr.tokenDeltaRaw > 0n) {
      // BUY
      const spent = tr.ethOutWei > 0n ? tr.ethOutWei : 0n;
      p.qtyBoughtRaw += tr.tokenDeltaRaw;
      p.ethSpentWei  += spent;
    } else if (tr.tokenDeltaRaw < 0n) {
      // SELL
      const sold  = -tr.tokenDeltaRaw;
      const recv  = tr.ethInWei > 0n ? tr.ethInWei : 0n;
      p.qtySoldRaw += sold;
      p.ethRecvWei += recv;
    }
  }

  // realized PnL (list realized even if still holding)
  for (const p of positions.values()) {
    const bought = p.qtyBoughtRaw;
    const sold   = p.qtySoldRaw;
    if (bought > 0n && sold > 0n) {
      const avgPerTokWei = p.ethSpentWei === 0n ? 0n : (p.ethSpentWei * ONE_E18) / bought;
      const cbSold = (avgPerTokWei * sold) / ONE_E18;
      p.realizedWei = p.ethRecvWei - cbSold;
    } else {
      p.realizedWei = 0n;
    }
  }

  // 5) Build lists
  const realizedItems = [];
  const openItems = [];

  const DUST_THRESHOLD = 5n;

  for (const p of positions.values()) {
    const heldRaw = p.qtyBoughtRaw - p.qtySoldRaw;
    const heldBig = heldRaw > 0n ? heldRaw : 0n;
    const heldIsDustClosed = heldBig <= DUST_THRESHOLD;

    const boughtNum = bnToNum(p.qtyBoughtRaw, p.decimals);
    const soldNum   = bnToNum(p.qtySoldRaw,   p.decimals);
    const avgBuyEth = (p.qtyBoughtRaw > 0n && p.ethSpentWei > 0n)
      ? (Number(p.ethSpentWei)/1e18) / boughtNum
      : 0;

    if (p.qtySoldRaw > 0n) {
      const buyEthPortion = avgBuyEth * soldNum;
      const sellEth = Number(p.ethRecvWei)/1e18;
      const realizedEth = Number(p.realizedWei)/1e18;
      const realizedPct = buyEthPortion > 0 ? (sellEth - buyEthPortion) / buyEthPortion * 100 : 0;

      realizedItems.push({
        token: p.token,
        symbol: p.symbol,
        decimals: p.decimals,
        buyEth: Number(+round4(buyEthPortion)),
        sellEth: Number(+round4(sellEth)),
        realizedEth: Number(+round4(realizedEth)),
        realizedPct: Number(+round4(realizedPct)),
        avgBuyEth: Number(+round4(avgBuyEth)),
        heldNum: bnToNum(heldBig, p.decimals),
      });
    }

    if (!heldIsDustClosed) {
      openItems.push({
        token: p.token,
        symbol: p.symbol,
        decimals: p.decimals,
        heldNum: bnToNum(heldBig, p.decimals),
        avgBuyEth: Number(+round4(avgBuyEth)),
      });
    }
  }

  // 6) Optional: enrich open via Alchemy balances (holdings with no recent trades)
  if (ALCHEMY_RPC) {
    try {
      const bals = await getAlchemyBalances(acct);
      const have = new Set(openItems.map(x => x.token.toLowerCase()));
      const add = [];
      for (const b of bals) {
        const ca = b.contractAddress;
        if (have.has(ca)) continue;
        const raw = BigInt(b.tokenBalanceHex);
        if (raw <= 0n) continue;
        add.push({ token: ca, symbol: '', decimals: 18, heldNum: 0, _raw: raw });
      }
      const metaByToken = {};
      for (const tr of trades) metaByToken[tr.token.toLowerCase()] = { decimals: tr.decimals, symbol: tr.symbol };
      for (const it of add) {
        const meta = metaByToken[it.token] || { decimals: 18, symbol: '' };
        it.decimals = meta.decimals;
        it.symbol   = meta.symbol || '';
        it.heldNum  = bnToNum(it._raw, it.decimals);
        delete it._raw;
        openItems.push(it);
      }
    } catch {}
  }

  // 7) Price open positions (USD + native). Also compute unrealized in native.
  const priceMap = await getTokenPairsBulk(openItems.map(x => x.token), chain);
  let holdingsUsd = 0;
  let unrealizedEthSum = 0;

  const openEnriched = openItems.map(o => {
    const info = priceMap[o.token?.toLowerCase()] || {};
    const priceUsd    = Number(info.priceUsd || 0);
    const priceNative = Number(info.priceNative || 0); // native per token
    const usd = priceUsd * (o.heldNum || 0);
    holdingsUsd += usd;

    // unrealized in native: current value in native minus cost basis for remaining tokens
    const currEth = priceNative * (o.heldNum || 0);
    const cbEth   = (o.avgBuyEth || 0) * (o.heldNum || 0);
    const uPnL    = currEth - cbEth;
    unrealizedEthSum += uPnL;

    return {
      ...o,
      name: info.name || '',
      symbol: info.symbol || o.symbol || '',
      usdNow: Number(+round2(usd)),
      priceNative: Number(+round4(priceNative)),
      unrealizedEth: Number(+round4(uPnL)),
    };
  })
  // filter tiny positions (>$0.10 only)
  .filter(x => x.usdNow >= 0.10)
  .sort((a,b)=> b.usdNow - a.usdNow);

  // 8) Airdrops
  const tokenAirdrops = {};
  for (const [hash, rec] of txmap.entries()) {
    if (sinceTs && rec.ts && rec.ts < sinceTs) continue;
    if (rec.ethOutWei !== 0n) continue;
    for (const [ca, d] of Object.entries(rec.tokenDeltas)) {
      if (d.deltaRaw > 0n) {
        const key = ca.toLowerCase();
        if (!tokenAirdrops[key]) tokenAirdrops[key] = { ca:key, qtyRaw:0n, decimals:d.decimals, symbol:d.symbol, name:d.name };
        tokenAirdrops[key].qtyRaw += d.deltaRaw;
      }
    }
  }
  const nftEvents = await getNFTtx(acct, { pageSize: 200 }, chain);
  const nftMap = new Map();
  for (const ev of nftEvents) {
    const ts = Number(ev.timeStamp||0);
    if (sinceTs && ts < sinceTs) continue;
    if (String(ev.to||'').toLowerCase() !== acct) continue;
    const rec = txmap.get(ev.hash);
    if (rec && rec.ethOutWei === 0n) {
      const key = String(ev.contractAddress||'').toLowerCase();
      const name = String(ev.tokenName||'') || 'NFT';
      nftMap.set(key, { contract:key, name, qty:(nftMap.get(key)?.qty || 0) + 1 });
    }
  }
  const dropTokens = Object.values(tokenAirdrops);
  const priceMapDrops = await getTokenPairsBulk(dropTokens.map(d => d.ca), chain);
  let airdropsUsd = 0;
  for (const d of dropTokens) {
    const info = priceMapDrops[d.ca] || {};
    const qty = bnToNum(d.qtyRaw, d.decimals);
    airdropsUsd += Number(info.priceUsd || 0) * qty;
  }
  airdropsUsd = Number(+round2(airdropsUsd));

  // 9) Totals
  let ETH_IN = 0;
  let ETH_OUT = 0;
  for (const tr of trades) {
    if (tr.tokenDeltaRaw > 0n) ETH_OUT += Number(tr.ethOutWei)/1e18;
    if (tr.tokenDeltaRaw < 0n) ETH_IN  += Number(tr.ethInWei)/1e18;
  }

  let realizedTotalEth = 0;
  for (const p of positions.values()) realizedTotalEth += Number(p.realizedWei)/1e18;

  // Filter out ETH/WETH from realized lists
  const realizedItemsFiltered = realizedItems.filter(
    x => !isETHLikeMeta({ token: x.token, symbol: x.symbol })
  );

  // Sort realized lists (ETH/WETH excluded)
  const fullProfits = realizedItemsFiltered
    .filter(x => x.realizedEth > 0)
    .sort((a,b) => b.realizedPct - a.realizedPct);

  const fullLosses = realizedItemsFiltered
    .filter(x => x.realizedEth < 0)
    .sort((a,b) => a.realizedPct - b.realizedPct);

  const topProfits = fullProfits.slice(0, 3);
  const topLosses  = fullLosses.slice(0, 3);

  const totals = {
    ethIn: Number(+round4(ETH_IN)),
    ethOut:Number(+round4(ETH_OUT)),
    realizedEth: Number(+round4(realizedTotalEth)),
    unrealizedEth: Number(+round4(unrealizedEthSum)),
    holdingsUsd: Number(+round2(holdingsUsd)),
    airdropsUsd,
    totalEth: Number(+round4(realizedTotalEth + unrealizedEthSum)),
    totalPct: Number(ETH_OUT > 0 ? +round4(((realizedTotalEth + unrealizedEthSum) / ETH_OUT) * 100) : 0),
  };

  // 10) Wallet ETH/native + WETH fold-in (for display on top of /pnl)
  let walletEth = '0';
  let walletWeth = '0';
  let walletEthTotal = '0';
  try {
    const wei = await getEthBalanceWei(acct, chain);
    walletEth = weiToEthStr(wei);
  } catch {}
  try {
    const wethRow = openEnriched.find(r => String(r.symbol || '').toUpperCase() === 'WETH');
    if (wethRow) walletWeth = String(wethRow.heldNum || '0');
  } catch {}
  {
    const toNum = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
    walletEthTotal = (toNum(walletEth) + toNum(walletWeth)).toFixed(6);
  }

  return {
    wallet: acct,
    window,
    totals,
    topProfits,
    topLosses,
    fullProfits,
    fullLosses,
    open: openEnriched,
    airdrops: {
      tokens: dropTokens.map(d => ({
        ca: d.ca,
        symbol: d.symbol,
        name: d.name,
        qty: bnToNum(d.qtyRaw, d.decimals)
      })),
      nfts: [...nftMap.values()]
    },
    walletEth,
    walletWeth,
    walletEthTotal,
    _meta: { now: Date.now(), chain: chain.key }
  };
}
