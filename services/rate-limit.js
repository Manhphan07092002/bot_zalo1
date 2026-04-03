function createRateLimiter({ windowMs, max }) {
  const hits = new Map();

  return function check(key) {
    const now = Date.now();
    const current = hits.get(key) || [];
    const valid = current.filter((ts) => now - ts < windowMs);

    if (valid.length >= max) {
      hits.set(key, valid);
      return false;
    }

    valid.push(now);
    hits.set(key, valid);
    return true;
  };
}

module.exports = { createRateLimiter };
