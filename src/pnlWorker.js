// ---- Add near your other constants (top of file) ----
const KNOWN_ROUTERS = new Set([
  // Moonshot / Abstract routing/proxy addresses you’ve seen:
  '0x0d6848e39114abe69054407452b8aab82f8a44ba'.toLowerCase(),
  // add more if you find them:
  // '0x....'
]);

// ---- Keep your existing getQuotes() helpers ----

// ---- New helper: best effort price (fallback if no ETH/WETH proceeds found) ----
async function estimateProceedsWeiFromPrice(token, amountUnits, priceWeth) {
  // amountUnits is BigInt token units; priceWeth is number (WETH per 1 token)
  if (!amountUnits || !priceWeth) return 0n;
  // convert amountUnits to float tokens using a rough 1e18 scale only to avoid BigInt->float overflows:
  // We’ll pass in scale externally so do nothing here. We’ll handle in computePnL where we know decimals.
  return 0n; // placeholder; real handling below using avg cost math + decimals
}

// ---- Modified computePnL with block-level linking + realized ranking ----
async function computePnL(wallet, { sinceTs = 0 }) {
  wallet = wallet.toLowerCase();

  // 1) Pull histories
  const [erc20, normal] = await Promise.all([
    getWalletERC20Txs(wallet, { fromTs: sinceTs }),
    getWalletNormalTxs(wallet, { fromTs: sinceTs })
  ]);

  // 2) Build ETH & WETH deltas per hash *and* per block (wallet perspective)
  const wethDeltaByHash = new Map(); // txHash -> +in / -out (wei)
  const ethDeltaByHash  = new Map(); // txHash -> +in / -out (wei)
  const blockEthNet     = new Map(); // blockNumber -> net +in/-out (wei)
  const blockWethNet    = new Map(); // blockNumber -> net +in/-out (wei)

  const tokenTxsByToken = new Map(); // tokenCA -> txs[]

  // Native ETH deltas (+ block net)
  for (const tx of normal) {
    const hash  = String(tx.hash);
    const bn    = Number(tx.blockNumber || 0);
    const from  = String(tx.from || '').toLowerCase();
    const to    = String(tx.to   || '').toLowerCase();
    const val   = toBig(tx.value || '0');

    let d = 0n;
    if (to === wallet && val > 0n) d = val;        // +in
    else if (from === wallet && val > 0n) d = -val; // -out

    if (d !== 0n) {
      ethDeltaByHash.set(hash, (ethDeltaByHash.get(hash) || 0n) + d);
      blockEthNet.set(bn, (blockEthNet.get(bn) || 0n) + d);
    }
  }

  // WETH deltas (+ block net) and group token txs
  for (const r of erc20) {
    const hash  = String(r.hash);
    const bn    = Number(r.blockNumber || 0);
    const token = String(r.contractAddress || '').toLowerCase();
    const to    = String(r.to   || '').toLowerCase();
    const from  = String(r.from || '').toLowerCase();
    const v     = toBig(r.value || '0');

    if (token === WETH) {
      let d = 0n;
      if (to === wallet) d = v; else if (from === wallet) d = -v;
      if (d !== 0n) {
        wethDeltaByHash.set(hash, (wethDeltaByHash.get(hash) || 0n) + d);
        blockWethNet.set(bn, (blockWethNet.get(bn) || 0n) + d);
      }
      continue;
    }

    if (to !== wallet && from !== wallet) continue;
    if (!tokenTxsByToken.has(token)) tokenTxsByToken.set(token, []);
    tokenTxsByToken.get(token).push(r);
  }

  const perToken = [];

  for (const [token, txs] of tokenTxsByToken.entries()) {
    // Chrono sort within token
    txs.sort((a,b) =>
      (Number(a.timeStamp) - Number(b.timeStamp)) ||
      (Number(a.blockNumber) - Number(b.blockNumber)) ||
      (Number(a.transactionIndex||0) - Number(b.transactionIndex||0)) ||
      (Number(a.logIndex||0) - Number(b.logIndex||0))
    );

    // One shot quotes used for MTM + fallback
    const { priceUsd, priceWeth } = await getQuotes(token);

    let qty = 0n;              // token units currently held
    let costWeth = 0n;         // cost basis for remaining (wei)
    let realizedWeth = 0n;     // realized PnL (wei)
    let buys = 0n, sells = 0n;

    const tokenDecimals = Math.max(0, Number(txs[0]?.tokenDecimal || 18));
    const scale = 10n ** BigInt(tokenDecimals);

    const airdrops = [];

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

      // BUY: wallet receives token and either pays ETH/WETH OR comes from token contract (bonding leg)
      if (to === wallet && (paidWei > 0n || from === token)) {
        buys += amt;
        qty  += amt;
        // if bonding-from-token and paidWei==0, we accept zero-cost inventory (unrealized will reflect value)
        costWeth += paidWei;
        continue;
      }

      // SELL (same-hash): wallet sends token and receives ETH/WETH in same tx
      if (from === wallet && recvWei > 0n) {
        sells += amt;

        const avgCostWeiPerUnit = qty > 0n ? (costWeth * 1_000_000_000_000_000_000n) / qty : 0n;
        const proceeds = recvWei;
        const costOfSold = (avgCostWeiPerUnit * amt) / 1_000_000_000_000_000_000n;

        realizedWeth += (proceeds - costOfSold);

        const newQty = qty > amt ? (qty - amt) : 0n;
        costWeth = newQty > 0n ? (avgCostWeiPerUnit * newQty) / 1_000_000_000_000_000_000n : 0n;
        qty = newQty;
        continue;
      }

      // PROXY / ROUTER SELL (different-hash settlement):
      // If token leaves wallet, but hash-level recvWei==0, look for block-level ETH/WETH net inflow.
      if (from === wallet && recvWei === 0n && (KNOWN_ROUTERS.has(to) || to === token)) {
        // Block-level net inflow is a signal of settlement via router in same block
        const blkInWei = ((blockEthNet.get(bn) || 0n) + (blockWethNet.get(bn) || 0n));
        const proceeds = blkInWei > 0n ? blkInWei : 0n;

        // If still zero, fallback to priceWeth * amount (approx)
        let estProceeds = proceeds;
        if (estProceeds === 0n && priceWeth > 0) {
          // amount tokens -> WETH (priceWeth is number)
          // estProceedsWei = amt * priceWeth * 1e18 / scale
          const amtFloat   = Number(amt) / Number(scale || 1n);
          const wethFloat  = amtFloat * Number(priceWeth);
          estProceeds = toBig(Math.floor(wethFloat * 1e18));
        }

        // Book realized like a sell:
        const avgCostWeiPerUnit = qty > 0n ? (costWeth * 1_000_000_000_000_000_000n) / qty : 0n;
        const costOfSold = (avgCostWeiPerUnit * (amt > qty ? qty : amt)) / 1_000_000_000_000_000_000n;

        realizedWeth += (estProceeds - costOfSold);

        // Reduce inventory
        const amtUsed = amt > qty ? qty : amt;
        const newQty = qty > amtUsed ? (qty - amtUsed) : 0n;
        costWeth = newQty > 0n ? (avgCostWeiPerUnit * newQty) / 1_000_000_000_000_000_000n : 0n;
        qty = newQty;
        sells += amt;
        continue;
      }

      // GIFT / INTERNAL OUT (no ETH/WETH proceeds and not a router/token): reduce qty + cost basis proportionally
      if (from === wallet && recvWei === 0n) {
        if (qty > 0n) {
          const avgCostWeiPerUnit = (costWeth * 1_000_000_000_000_000_000n) / (qty || 1n);
          const amtUsed = amt > qty ? qty : amt;
          const costReduction = (avgCostWeiPerUnit * amtUsed) / 1_000_000_000_000_000_000n;
          qty -= amtUsed;
          costWeth = costWeth > costReduction ? (costWeth - costReduction) : 0n;
        }
        continue;
      }

      // AIRDROP: inbound token with no ETH/WETH leg and not from token (avoid bonding false positives)
      if (to === wallet && paidWei === 0n && from !== token) {
        airdrops.push({ hash, amount: amt });
        qty += amt; // at zero cost
        continue;
      }
    }

    // Mark-to-market
    const qtyFloat   = Number(qty) / Number(scale || 1n);
    const invCostW  = Number(costWeth) / 1e18;
    const mtmW      = qtyFloat * Number(priceWeth || 0);
    const unrealW   = mtmW - invCostW;
    const usdValue  = qtyFloat * Number(priceUsd || 0);

    // Airdrops USD
    let adUnits = 0n;
    for (const a of airdrops) adUnits += a.amount;
    const adQty = Number(adUnits) / Number(scale || 1n);
    const adUsd = adQty * Number(priceUsd || 0);

    // Dust filter: hide <5 tokens (not ETH/WETH)
    const symUp = String(txs[0]?.tokenSymbol || '').toUpperCase();
    const isEthLike = (symUp === 'ETH') || (symUp === 'WETH') || (token === WETH);
    const MIN_UNITS = 5n * (10n ** BigInt(tokenDecimals));
    const keep = (qty === 0n) || isEthLike || qty >= MIN_UNITS; // keep closed positions too

    if (!keep) {
      // If it’s closed (qty==0) we still want to keep it for realized reporting
      if (qty !== 0n) return; // skip only if tiny open remainder
    }

    perToken.push({
      token,
      symbol: txs[0]?.tokenSymbol || '',
      decimals: tokenDecimals,

      buys: buys.toString(),
      sells: sells.toString(),
      remaining: qty.toString(),

      realizedWeth: Number(realizedWeth) / 1e18,  // float
      inventoryCostWeth: Number(costWeth) / 1e18, // float
      priceUsd: Number(priceUsd || 0),
      priceWeth: Number(priceWeth || 0),
      unrealizedWeth: unrealW,                     // float
      usdValueRemaining: usdValue,                 // float

      airdrops: {
        count: airdrops.length,
        units: adUnits.toString(),
        estUsd: adUsd
      }
    });
  }

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

  // Wallet ETH/WETH net flows (all hashes)
  let wethIn = 0n, wethOut = 0n;
  for (const v of wethDeltaByHash.values()) { if (v > 0n) wethIn += v; else wethOut += (-v); }
  let ethIn = 0n, ethOut = 0n;
  for (const v of ethDeltaByHash.values())  { if (v > 0n)  ethIn += v; else  ethOut += (-v); }

  const wethInFloat  = Number(wethIn)  / 1e18;
  const wethOutFloat = Number(wethOut) / 1e18;
  const ethInFloat   = Number(ethIn)   / 1e18;
  const ethOutFloat  = Number(ethOut)  / 1e18;

  const totalPnlWeth = totalRealizedWeth + totalUnrealizedWeth;
  const spentBase    = wethOutFloat + ethOutFloat;
  const pnlPct       = spentBase > 0 ? (totalPnlWeth / spentBase) * 100 : 0;

  // ---- Derived lists ----
  const openPositions = perToken.filter(t => Number(t.remaining) > 0);
  const airdropsFlat  = perToken
    .filter(t => (t.airdrops?.count || 0) > 0)
    .map(t => ({ token: t.token, symbol: t.symbol, decimals: t.decimals, units: t.airdrops.units, estUsd: t.airdrops.estUsd }));

  // Realized leaders (do NOT require closed-only)
  const realizedOnly = perToken.filter(t => Math.abs(Number(t.realizedWeth) || 0) > 0);
  const best  = [...realizedOnly].sort((a,b)=> (Number(b.realizedWeth)||0) - (Number(a.realizedWeth)||0)).slice(0, 15);
  const worst = [...realizedOnly].sort((a,b)=> (Number(a.realizedWeth)||0) - (Number(b.realizedWeth)||0)).slice(0, 15);

  return {
    wallet,
    sinceTs,
    totals: {
      // Raw
      wethIn: wethIn.toString(),   wethOut: wethOut.toString(),
      ethIn:  ethIn.toString(),    ethOut:  ethOut.toString(),
      // Floats
      wethInFloat,  wethOutFloat,
      ethInFloat,   ethOutFloat,
      // PnL
      realizedWeth: totalRealizedWeth,
      unrealizedWeth: totalUnrealizedWeth,
      totalPnlWeth,
      pnlPct,
      airdropsUsd: totalAirdropUsd,
      holdingsUsd: totalHoldingsUsd
    },
    tokens: perToken,
    derived: {
      open: openPositions,
      airdrops: airdropsFlat,
      best,
      worst
    }
  };
}