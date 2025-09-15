const redis = new Redis(process.env.REDIS_URL); // Assume ioredis

async function getJSON(key) {
  const val = await redis.get(key);
  return val ? JSON.parse(val) : null;
}

async function setJSON(key, val, ttl) {
  const str = JSON.stringify(val);
  if (ttl) {
    await redis.setex(key, ttl, str);
  } else {
    await redis.set(key, str);
  }
}

async function withLock(key, ttlSec, fn) {
  const lockKey = `${key}:lock`;
  const acquired = await redis.set(lockKey, 'locked', 'NX', 'EX', ttlSec);
  if (!acquired) return null; // Already locked
  try {
    return await fn();
  } finally {
    await redis.del(lockKey);
  }
}

// For last_refresh (scalar, but JSON-wrapped)
async function getLastRefresh(key) {
  return await getJSON(`${key}:last_refresh`) || 0;
}

async function setLastRefresh(key, timestamp) {
  await setJSON(`${key}:last_refresh`, timestamp);
}

module.exports = { getJSON, setJSON, withLock, getLastRefresh, setLastRefresh };
