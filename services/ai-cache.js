const cache = new Map();

function getCached(key, ttlMs = 120000) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > ttlMs) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function setCached(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

module.exports = { getCached, setCached };
