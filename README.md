#How it works (process overview)

Goal: deliver instant responses in TG without hammering APIs.
1. Worker fetches → Cache + DB (optional)

- A separate worker process pulls data from:
Dexscreener (Abstract chain) for price, % change, volume, market cap (FDV)
Abscan / Etherscan-v2 for creator, holders (top list), and transfers

- Results are precomputed into compact JSON payloads and stored in Redis with a short TTL (default 180s).
- The worker runs every 120s per token (when scheduled) and also on on-demand requests.

2. No-stampede refresh

- When a user calls /refresh, the bot:
checks last_refresh:<token> (30s cooldown)
acquires a refresh_lock:<token> to ensure a single fetch job
enqueues one BullMQ job if allowed

3. Bot is read-only + instant

- The Telegram bot (Telegraf) serves data from Redis for speed.
- On first request (cold start), it attempts a synchronous refresh once; if that fails, it
enqueues a job and tells the user it’s initializing.

4. Precomputed analytics

- Top-10 % = sum of holder list Percentage for first 10.

- Burned % = Percentage for 0x000…0000 + 0x000…dead if present.

- Creator % = find creator address within the holder list and read its %.

- First 20 buyers = take earliest token transfer recipients (unique), then compare their current balance vs first received:
current == 0 → SOLD ALL
current < first → SOLD SOME
current == first → HOLD
current > first → BOUGHT MORE

#Data flow diagram
User -> Telegram -> Telegraf Bot
                      |
                      | Redis GET (token:<ca>:summary)
                      v
            (cache hit) Reply instantly
                      ^
                      | (cache miss)  enqueue refresh job
                      |
                   BullMQ Queue <---- Scheduler (120s)
                      |
                   Worker
             /        |         \
 Dexscreener   Abscan/Etherscan   (other sources)
      \           /        \
     Market   Holders   Transfers
          \      |         /
           Compute & Merge
                |
              Redis SET (TTL)

#Commands (bot)
Command	Description
/start	Short intro + usage
/stats <contract>	Shows the full stats block for a token
/refresh <contract>	Triggers a refresh (30s cooldown per token)

#Functions & modules (what they do)
src/services/dexscreener.js

- getDexscreenerTokenStats(tokenAddress)
Queries Dexscreener for pools matching the token CA, filters to Abstract, picks the most liquid pair, and returns:
name, symbol, priceUsd, volume24h, priceChange: {h1,h6,h24}, marketCap (FDV)

- src/services/abscan.js
getContractCreator(contractAddress)
Etherscan-style endpoint to fetch contract deployer address and creation tx.

getTokenHolders(contractAddress, page=1, offset=100)
Etherscan-style token holder list (returns address, quantity, percentage). Used to compute:

creator %, top-10 %, burned %, top-20 listing, and current balances.

getTokenTransfers(contractAddress, startBlock=0, endBlock=..., page=1, offset=1000)
Etherscan-style token transfer list. Used to identify the first 20 buyers.

- src/services/compute.js
summarizeHolders(holders)
Normalizes top 20 holders, sums top-10 %, and detects burned %.

buildCurrentBalanceMap(holders)
Map of address -> quantity (used when comparing buyers’ first receive vs current).

first20BuyersStatus(transfersAsc, currentBalancesMap)
Extracts first 20 unique recipients from earliest transfers, classifies status:
HOLD, SOLD ALL, SOLD SOME, BOUGHT MORE.

renderTop20Holders(top20), renderFirst20Buyers(rows)
Renders neat text blocks for Telegram.

- src/refreshWorker.js
refreshToken(tokenAddress)
Orchestrates fetching from Dexscreener + Abscan/Etherscan, runs computations, writes a single JSON payload into Redis:

{
  "tokenAddress": "...",
  "updatedAt": 172...,
  "market": { "name": "...", "symbol": "...", "priceUsd": 0, "volume24h": 0, "priceChange": {"h1":0,"h6":0,"h24":0}, "marketCap": 0 },
  "holdersTop20": [{ "address": "...", "percent": 0.0 }, ...],
  "top10CombinedPct": 0.0,
  "burnedPct": 0.0,
  "creator": { "address": "0x...", "percent": 0.0 },
  "first20Buyers": [{ "address": "0x...", "status": "HOLD" }, ...]
}


BullMQ Worker consumes queue jobs, and an optional scheduler loop (if --cron and DEFAULT_TOKENS set) enqueues refreshes every 120s.

- src/bot.js
/stats command: validates CA, ensures cached or triggers a synchronous refresh (first time), and prints a MarkdownV2-escaped block with all sections.

/refresh command: enforces the 30s cooldown and enqueues a refresh job.

Small helpers to escape Markdown and format numbers.

- src/cache.js
Redis wrapper:
getJSON(key), setJSON(key, val, ttl?)
withLock(key, ttlSec, fn) — simple lock to prevent duplicate refresh.

- src/util.js
Helpers: sleep, isAddress, shortAddr, pct, num, now.

#Environment variables (reference)
Variable	Purpose
BOT_TOKEN	Telegram bot token
REDIS_URL	Redis connection string
ETHERSCAN_V2_BASE	Etherscan v2 API base (use with ETHERSCAN_API_KEY)
ETHERSCAN_API_KEY	Etherscan API key
ABSCAN_BASE	Abscan API base (use with ABSCAN_API_KEY)
ABSCAN_API_KEY	Abscan API key
DEFAULT_TOKENS	Comma-separated CAs to auto-refresh every 120s

Provide either the Etherscan v2 variables or the Abscan variables.

#Output format (Telegram)

- The /stats response prints:
Header with Name / Symbol and CA
Price & 24h Volume
1h / 6h / 24h % Change
Market Cap (FDV)
Creator (address and %)
Top 10 combined %
Burned %
First 20 Buyers (status)
Top 20 Holders (%)
Updated timestamp

Long lists are neatly numbered; addresses are shortened.

#Tips & caveats

Market Cap from Dexscreener is generally FDV for new tokens. If you need circulating market cap, you’ll need a reliable circulating supply source.

Very fresh tokens may not have holder lists populated immediately on Abscan/Etherscan; buyers/holders sections fill in once the indexer catches up.

“First buyers” logic is heuristic (first transfer recipients). You can refine: exclude router/LP addresses, known contracts, etc.

#Troubleshooting

“Initializing… try again”
First request was a cold start and the synchronous refresh failed or timed out. Try /stats again; the job has been queued.

No market data
Dexscreener may not have a pair indexed yet for the Abstract token. Check the token or wait until a pair is live.

Creator % is 0
The creator may not appear in the top 100 holders retrieved. Increase offset in getTokenHolders if needed (trade API limits vs latency).

Cooldown message on /refresh
The bot enforces a 30s manual refresh cooldown per token to avoid API spam.

#Extending

Add inline buttons (e.g., “↻ Refresh”, “Next page holders”) via reply_markup.

Persist historical snapshots in Postgres if you want charts or time-series.

Add more chains by parameterizing the chain slug for Dexscreener and the chainid for Etherscan v2.

#License

MIT (or align with your repo license).


In one terminal:

npm run worker


In another:

npm start

5) Run with PM2 (prod)
pm2 start ecosystem.config.js
pm2 save
