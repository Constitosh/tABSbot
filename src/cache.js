import Redis from 'ioredis';
import 'dotenv/config';
const redis = new Redis(process.env.REDIS_URL, {
  // BullMQ requires this to be null for blocking ops
 maxRetriesPerRequest: null,
 // avoids an extra INFO/ROLE roundtrip that can stall in some setups
 enableReadyCheck: false
});

export const getJSON = async (k) => {
  const v = await redis.get(k);
  return v ? JSON.parse(v) : null;
};
export const setJSON = (k, v, ttl=null) =>
  ttl ? redis.set(k, JSON.stringify(v), 'EX', ttl) : redis.set(k, JSON.stringify(v));

export const withLock = async (key, ttlSec, fn) => {
  const ok = await redis.set(key, '1', 'NX', 'EX', ttlSec);
  if (!ok) return false;
  try { return await fn(); }
  finally { await redis.del(key); }
};

export const redisClient = redis;
