import './configEnv.js';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const redisClient = redis;

export const getJSON = async (key) => {
  const v = await redis.get(key);
  return v ? JSON.parse(v) : null;
};
export const setJSON = (key, val, ttl = null) => {
  const s = JSON.stringify(val);
  return ttl ? redis.set(key, s, 'EX', ttl) : redis.set(key, s);
};

export const withLock = async (key, ttlSec, fn) => {
  const ok = await redis.set(key, '1', 'NX', 'EX', ttlSec);
  if (!ok) return false;
  try { return await fn(); } finally { await redis.del(key); }
};