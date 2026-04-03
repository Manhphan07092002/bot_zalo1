const path = require('path');
const fs = require('fs');

function loadEnvFile() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;

    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: toNumber(process.env.PORT, 3000),
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  nodeEnv: process.env.NODE_ENV || 'development',
  apiKey: process.env.API_KEY || '',
  quoteApiUrl: process.env.QUOTE_API_URL || 'http://127.0.0.1:3000/api/quote',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramAllowedChatIds: toList(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
  rateLimitWindowMs: toNumber(process.env.RATE_LIMIT_WINDOW_MS, 60000),
  rateLimitMax: toNumber(process.env.RATE_LIMIT_MAX, 30),
  renderTimeoutMs: toNumber(process.env.RENDER_TIMEOUT_MS, 30000),
  corsOrigins: toList(process.env.CORS_ORIGINS),
  companyName: process.env.COMPANY_NAME || 'CÔNG TY CỔ PHẦN XÂY LẮP BƯU ĐIỆN MIỀN TRUNG - CTC',
  companyAddress: process.env.COMPANY_ADDRESS || '50B Nguyễn Du, Phường Hải Châu, Thành phố Đà Nẵng, Việt Nam.',
  companyPhone: process.env.COMPANY_PHONE || '02363.745.745 - 02363.745.746',
  companyEmail: process.env.COMPANY_EMAIL || 'ctcdanang@gmail.com',
  defaultProfitRate: toNumber(process.env.DEFAULT_PROFIT_RATE, 12),
  defaultVatPercent: toNumber(process.env.DEFAULT_VAT_PERCENT, 8),
  aiProvider: (process.env.AI_PROVIDER || '').toLowerCase(),
  aiApiKey: process.env.AI_API_KEY || '',
  aiModel: process.env.AI_MODEL || '',
  aiEnabled: ['1', 'true', 'yes', 'on'].includes(String(process.env.AI_ENABLED || '').toLowerCase())
};

module.exports = { config };
