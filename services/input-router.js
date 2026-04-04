const crypto = require('crypto');
const { parseQuoteRequest } = require('./telegram-parser');
const { parseUnifiedInput } = require('./ai-input-parser');
const { getCached, setCached } = require('./ai-cache');

function hashInput(parts) {
  const h = crypto.createHash('sha1');
  for (const part of parts) {
    h.update(part || '');
    h.update('\n---\n');
  }
  return h.digest('hex');
}

function isTextClearEnough(payload) {
  return !!(
    payload?.customer?.name &&
    Array.isArray(payload?.items) &&
    payload.items.length > 0 &&
    payload.items.every((item) => item.description && item.quantity > 0 && item.costPrice > 0)
  );
}

async function routeInput({ text = '', imageBuffer = null, mimeType = 'image/jpeg' }, defaults = {}) {
  if (!imageBuffer) {
    const parsed = parseQuoteRequest(text, defaults);
    if (isTextClearEnough(parsed)) {
      return { payload: parsed, mode: 'rule-based-clear-text' };
    }
  }

  const cacheKey = hashInput([
    text,
    imageBuffer ? imageBuffer.toString('base64').slice(0, 20000) : '',
    mimeType
  ]);
  const cached = getCached(cacheKey);
  if (cached) {
    return { payload: cached, mode: 'ai-cached' };
  }

  const payload = await parseUnifiedInput({ text, imageBuffer, mimeType }, defaults);
  setCached(cacheKey, payload);
  return { payload, mode: imageBuffer ? 'ai-image' : 'ai-text' };
}

module.exports = { routeInput };
