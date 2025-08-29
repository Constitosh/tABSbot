1) Requirements

Node.js 18+

Redis (local or managed)

Telegram Bot Token (from @BotFather)

API key for Abscan or Etherscan v2 (multichain)

2) Install
git clone <your repo> tabs-tools
cd tabs-tools
npm i

3) Configure .env

Create .env in the project root:

# Telegram
BOT_TOKEN=123456:your-telegram-bot-token

# Redis
REDIS_URL=redis://127.0.0.1:6379

# Option A: Etherscan v2 multichain (uses chainid=2741 for Abstract)
ETHERSCAN_V2_BASE=https://api.etherscan.io/v2/api
ETHERSCAN_API_KEY=your-etherscan-key

# Option B: Abscan (Etherscan-compatible v1 style)
# ABSCAN_BASE=https://api.abscan.org/api
# ABSCAN_API_KEY=your-abscan-key

# Optional: list of default tokens to auto-refresh every 120s
# DEFAULT_TOKENS=0xabc...,0xdef...


Use one of Option A or B. If you provide ETHERSCAN_V2_BASE, the bot will pass chainid=2741 automatically.

4) Run (dev)

In one terminal:

npm run worker


In another:

npm start

5) Run with PM2 (prod)
pm2 start ecosystem.config.js
pm2 save

Telegram usage

/start — show help

/stats <contract> — fetch and display the full stats block

/refresh <contract> — force a refresh (if last refresh ≥ 30s ago)

Examples:

/stats 0x1234...abcd
/refresh 0x1234...abcd

How it works (process overview)

Goal: deliver instant responses in TG without hammering APIs.

Worker fetches → Cache + DB (optional)

A separate worker process pulls data from:

Dexscreener (Abstract chain) for price, % change, volume, market cap (FDV)

Abscan / Etherscan-v2 for creator, holders (top list), and transfers

Results are precomputed into compact JSON payloads and stored in Redis with a short TTL (default 180s).

The worker runs every 120s per token (when scheduled) and also on on-demand requests.

No-stampede refresh

When a user calls /refresh, the bot:

checks last_refresh:<token> (30s cooldown)

acquires a refresh_lock:<token> to ensure a single fetch job

enqueues one BullMQ job if allowed

Bot is read-only + instant

The Telegram bot (Telegraf) serves data from Redis for speed.

On first request (cold start), it attempts a synchronous refresh once; if that fails, it enqueues a job and tells the user it’s initializing.

Precomputed analytics

Top-10 % = sum of holder list Percentage for first 10.

Burned % = Percentage for 0x000…0000 + 0x000…dead if present.

Creator % = find creator address within the holder list and read its %.

First 20 buyers = take earliest token transfer recipients (unique), then compare their current balance vs first received:

current == 0 → SOLD ALL

current < first → SOLD SOME

current == first → HOLD

current > first → BOUGHT MORE

Data flow diagram
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

Commands (bot)
Command	Description
/start	Short intro + usage
/stats <contract>	Shows the full stats block for a token
/refresh <contract>	Triggers a refresh (30s cooldown per token)
