// src/cache.js
import './configEnv.js';
import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error('[CACHE] REDIS_URL is missing — check .env');
}
export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,   // friendly with BullMQ if shared
  enableReadyCheck: false
});

redis.on('error', (e) => console.error('[CACHE] Redis error:', e?.message || e));
redis.on('connect', () => console.log('[CACHE] Connected to', REDIS_URL));

export async function getJSON(key) {
  const v = await redis.get(key);
  return v ? JSON.parse(v) : null;
}

export async function setJSON(key, val, ttl) {
  const s = JSON.stringify(val);
  if (ttl && Number.isFinite(ttl)) {
    const res = await redis.set(key, s, 'EX', ttl);
    if (res !== 'OK') console.warn('[CACHE] SET (EX) returned', res, 'for key', key);
    return res;
  } else {
    const res = await redis.set(key, s);
    if (res !== 'OK') console.warn('[CACHE] SET returned', res, 'for key', key);
    return res;
  }
}

/** Simple lock with SET NX EX; releases on finish. */
export async function withLock(lockKey, ttlSec, fn) {
  const token = String(Date.now()) + Math.random().toString(16).slice(2);
  const ok = await redis.set(lockKey, token, 'EX', Math.max(1, ttlSec|0), 'NX');
  if (ok !== 'OK') {
    // Someone else holds the lock — just skip
    return null;
  }
  try {
    return await fn();
  } finally {
    // Release only if still ours
    try {
      const v = await redis.get(lockKey);
      if (v === token) await redis.del(lockKey);
    } catch (e) {
      console.warn('[CACHE] lock release failed:', e?.message || e);
    }
  }
}