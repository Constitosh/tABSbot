// src/queueCore.js
import './configEnv.js';
import Redis from 'ioredis';
import { Queue } from 'bullmq';

// BullMQ-safe Redis (same options as worker)
const bullRedis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const queueName = 'tabs_refresh'; // must match refreshWorker.js
export const queue = new Queue(queueName, { connection: bullRedis });

// Helper the bot can use to enqueue a refresh
export async function requestRefresh(tokenAddress) {
  const ca = String(tokenAddress || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(ca)) throw new Error(`Bad CA: ${tokenAddress}`);
  return queue.add('refresh', { tokenAddress: ca }, { removeOnComplete: true, removeOnFail: true });
}