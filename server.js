const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { renderQuotePdf } = require('./services/render-quote-pdf');
const { buildQuoteData } = require('./services/quote-data');
const { config } = require('./services/config');
const { createScope } = require('./services/logger');
const { appendQuoteHistory, saveQuoteSource } = require('./services/history-store');
const { createRateLimiter } = require('./services/rate-limit');
const pkg = require('./package.json');

const log = createScope('server');
const app = express();
const rateLimit = createRateLimiter({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMax
});

const corsOptions = config.corsOrigins.length
  ? {
      origin(origin, callback) {
        if (!origin || config.corsOrigins.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error('CORS blocked'));
      }
    }
  : undefined;

app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  if (!rateLimit(req.ip || 'local')) {
    log.warn('API bị rate limit', { ip: req.ip || 'local', path: req.path });
    return res.status(429).json({ error: 'Quá nhiều yêu cầu, vui lòng thử lại sau.' });
  }

  if (config.apiKey && req.path === '/api/quote') {
    const incomingApiKey = req.headers['x-api-key'];
    if (incomingApiKey !== config.apiKey) {
      log.warn('API key không hợp lệ', { ip: req.ip || 'local', path: req.path });
      return res.status(401).json({ error: 'Thiếu hoặc sai API key.' });
    }
  }

  return next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'ctc-quote-api', version: pkg.version, env: config.nodeEnv, time: new Date().toISOString() });
});

app.get('/version', (req, res) => {
  res.json({ name: pkg.name, version: pkg.version });
});

app.post('/api/quote', async (req, res) => {
  const startedAt = Date.now();

  try {
    const inputData = req.body;

    if (!inputData || Object.keys(inputData).length === 0) {
      log.warn('API quote nhận payload rỗng', { ip: req.ip || 'local' });
      return res.status(400).json({ error: 'Payload không hợp lệ' });
    }

    log.info('API quote bắt đầu xử lý', {
      ip: req.ip || 'local',
      createdBy: inputData?.meta?.createdBy || '',
      createdByName: inputData?.meta?.createdByName || '',
      customerName: inputData?.customer?.name || inputData?.customerName || '',
      itemCount: Array.isArray(inputData?.items) ? inputData.items.length : Array.isArray(inputData?.products) ? inputData.products.length : 1
    });

    const data = buildQuoteData(inputData);
    const fileName = `${data.quoteNumber}-bao-gia-${Date.now()}.pdf`;
    const outputPath = path.resolve(__dirname, 'output', fileName);
    const sentPath = path.resolve(__dirname, 'output', 'sent', fileName);
    const templatePath = path.resolve(__dirname, 'templates', 'bao-gia-ctc.html');

    await renderQuotePdf({ templatePath, outputPath, data });
    fs.mkdirSync(path.dirname(sentPath), { recursive: true });
    fs.copyFileSync(outputPath, sentPath);

    const sourcePath = saveQuoteSource(data.quoteNumber, inputData);

    appendQuoteHistory({
      quoteNumber: data.quoteNumber,
      customerName: data.customerName,
      customerReceiver: data.customerReceiver,
      itemCount: Array.isArray(inputData.items) ? inputData.items.length : Array.isArray(inputData.products) ? inputData.products.length : 1,
      total: data.grandTotal,
      source: req.headers['user-agent'] || 'api',
      sourcePath,
      createdBy: inputData?.meta?.createdBy || '',
      createdByName: inputData?.meta?.createdByName || '',
      createdByUsername: inputData?.meta?.createdByUsername || ''
    });

    log.info('Đã tạo PDF', {
      quoteNumber: data.quoteNumber,
      customerName: data.customerName,
      durationMs: Date.now() - startedAt
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${data.quoteNumber}-bao-gia-ctc.pdf"`);

    const fileStream = fs.createReadStream(outputPath);
    fileStream.pipe(res);

    fileStream.on('end', () => {
      fs.unlink(outputPath, (err) => {
        if (err) log.warn('Lỗi xóa file PDF tạm', err.message);
      });
    });
  } catch (err) {
    log.error('Lỗi tạo API báo giá', {
      error: err.message,
      stack: err?.stack || '',
      durationMs: Date.now() - startedAt
    });
    res.status(500).json({ error: 'Lỗi server khi tạo báo giá', details: err.message });
  }
});

app.listen(config.port, config.host, () => {
  log.info(`Server API đang chạy tại http://${config.host}:${config.port}`);
  log.info(`POST JSON tới: http://${config.host}:${config.port}/api/quote`);
});
