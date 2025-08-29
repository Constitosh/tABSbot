import Redis from 'ioredis';
import 'dotenv/config';
const redis = new Redis(process.env.REDIS_URL);

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
