import 'dotenv/config';
import Redis from 'ioredis';

if (!process.env.REDIS_URL) {
  console.error('Cache: Missing REDIS_URL in .env');
  process.exit(1);
}

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});
redis.on('connect', () => console.log('Cache: Redis connected'));
redis.on('error', (err) => console.error('Cache: Redis error:', err.message));

let inMemoryFallback = new Map();

async function getJSON(key) {
  try {
    const val = await redis.get(key);
    if (val) return JSON.parse(val);
    const fallback = inMemoryFallback.get(key);
    return fallback || null;
  } catch (err) {
    console.error('Cache getJSON error:', err.message);
    return inMemoryFallback.get(key) || null;
  }
}

async function setJSON(key, val, ttl) {
  try {
    const str = JSON.stringify(val);
    if (ttl) {
      await redis.setex(key, ttl, str);
    } else {
      await redis.set(key, str);
    }
    inMemoryFallback.set(key, val);
    if (ttl) setTimeout(() => inMemoryFallback.delete(key), ttl * 1000);
  } catch (err) {
    console.error('Cache setJSON error:', err.message);
    inMemoryFallback.set(key, val);
    if (ttl) setTimeout(() => inMemoryFallback.delete(key), ttl * 1000);
  }
}

async function withLock(key, ttlSec, fn) {
  try {
    const lockKey = `${key}:lock`;
    const acquired = await redis.set(lockKey, 'locked', 'NX', 'EX', ttlSec);
    if (!acquired) return null;
    try {
      return await fn();
    } finally {
      await redis.del(lockKey);
    }
  } catch (err) {
    console.error('Cache withLock error:', err.message);
    return null;
  }
}

export { getJSON, setJSON, withLock, redis };