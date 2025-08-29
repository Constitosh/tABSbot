// src/cache.js
import './configEnv.js';
import Redis from 'ioredis';

// Single shared ioredis client for the app (BullMQ gets its own in refreshWorker.js)
const redis = new Redis(process.env.REDIS_URL, {
  // BullMQ-safe if you ever reuse this client there; harmless for normal app ops
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// Export the client once
export const redisClient = redis;

// Helper: get/set JSON with optional TTL
export const getJSON = async (key) => {
  const v = await redis.get(key);
  return v ? JSON.parse(v) : null;
};

export const setJSON = (key, val, ttl = null) => {
  const s = JSON.stringify(val);
  return ttl ? redis.set(key, s, 'EX', ttl) : redis.set(key, s);
};

// Simple lock with TTL (prevents duplicate refresh jobs)
export const withLock = async (key, ttlSec, fn) => {
  const ok = await redis.set(key, '1', 'NX', 'EX', ttlSec);
  if (!ok) return false;
  try {
    return await fn();
  } finally {
    await redis.del(key);
  }
};
