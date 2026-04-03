const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function getHistoryPath() {
  return path.resolve(__dirname, '..', 'data', 'quote-history.json');
}

function getLockPath() {
  return path.resolve(__dirname, '..', 'data', 'quote-counter.lock');
}

function withFileLock(lockPath, fn) {
  const startedAt = Date.now();

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        return fn();
      } finally {
        fs.closeSync(fd);
        fs.unlinkSync(lockPath);
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() - startedAt > 5000) {
        throw new Error('Không lấy được lock file để cấp số báo giá.');
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function getNextQuoteNumber(counterPath) {
  return withFileLock(getLockPath(), () => {
    const data = readJsonSafe(counterPath, { currentId: 0 });
    const currentId = Number(data.currentId || 0) + 1;
    writeJson(counterPath, { currentId, updatedAt: new Date().toISOString() });
    return String(currentId).padStart(3, '0');
  });
}

function appendQuoteHistory(entry) {
  const historyPath = getHistoryPath();
  const history = readJsonSafe(historyPath, []);
  history.unshift({ ...entry, createdAt: new Date().toISOString() });
  writeJson(historyPath, history.slice(0, 500));
}

module.exports = {
  appendQuoteHistory,
  getNextQuoteNumber
};
