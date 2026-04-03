const { config } = require('./services/config');
const { createScope } = require('./services/logger');
const { parseQuoteRequest, validatePayload } = require('./services/telegram-parser');
const { createRateLimiter } = require('./services/rate-limit');
const TelegramBot = require('node-telegram-bot-api');

const log = createScope('telegram-bot');
const BOT_TOKEN = config.telegramBotToken;
const rateLimit = createRateLimiter({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMax
});

if (!BOT_TOKEN) {
  log.error('Thiếu TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function isAllowedChat(chatId) {
  if (!config.telegramAllowedChatIds.length) return true;
  return config.telegramAllowedChatIds.includes(String(chatId));
}

async function createQuotePdf(payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.renderTimeoutMs);

  try {
    const res = await fetch(config.quoteApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey || ''
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!res.ok) {
      let msg = '';
      try {
        msg = await res.text();
      } catch (_) {}
      throw new Error(`API báo giá lỗi ${res.status}: ${msg || 'không rõ lỗi'}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/pdf')) {
      const txt = await res.text();
      throw new Error(`API không trả PDF: ${txt}`);
    }

    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/i);
    const fileName = match ? match[1] : 'bao-gia-ctc.pdf';

    const arrayBuffer = await res.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), fileName };
  } finally {
    clearTimeout(timeout);
  }
}

bot.onText(/\/start/i, async (msg) => {
  if (!isAllowedChat(msg.chat.id)) {
    await bot.sendMessage(msg.chat.id, 'Chat này chưa được phép sử dụng bot.');
    return;
  }

  await bot.sendMessage(
    msg.chat.id,
    [
      'Bot báo giá CTC đã sẵn sàng.',
      '',
      'Mẫu nhập:',
      'Khách hàng: VIỄN THÔNG HUẾ',
      'Người nhận: Nguyễn Bá Toàn',
      'Bộ phận: Kỹ thuật',
      'Điện thoại: 0912345678',
      'Email: abc@example.com',
      '',
      'Hàng hóa:',
      '1. Bộ chuyển đổi tín hiệu Mini Converter SDI to HDMI 6G | China | cái | 2 | 1.850.000 | Ghi chú tùy chọn',
      '',
      `Lãi suất: ${config.defaultProfitRate}`,
      `VAT: ${config.defaultVatPercent}`
    ].join('\n')
  );
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  try {
    if (!text || text.startsWith('/start')) return;

    if (!isAllowedChat(chatId)) {
      await bot.sendMessage(chatId, 'Chat này chưa được phép sử dụng bot.');
      return;
    }

    if (!rateLimit(String(chatId))) {
      await bot.sendMessage(chatId, 'Anh gửi hơi nhanh, vui lòng chờ một chút rồi thử lại.');
      return;
    }

    const payload = parseQuoteRequest(text, {
      defaultProfitRate: config.defaultProfitRate,
      defaultVatPercent: config.defaultVatPercent
    });

    const validationError = validatePayload(payload);
    if (validationError) {
      await bot.sendMessage(chatId, `Chưa tạo được báo giá. ${validationError}`);
      return;
    }

    log.info('Đang tạo báo giá', {
      chatId,
      customerName: payload.customer.name,
      itemCount: payload.items.length
    });

    await bot.sendMessage(chatId, `Em đang tạo báo giá cho ${payload.customer.name}...`);

    const { buffer, fileName } = await createQuotePdf(payload);

    await bot.sendDocument(
      chatId,
      buffer,
      {
        caption: `Báo giá đã tạo xong cho ${payload.customer.name}. Em gửi file PDF đính kèm bên dưới.`
      },
      {
        filename: fileName,
        contentType: 'application/pdf'
      }
    );
  } catch (err) {
    log.error('Lỗi bot Telegram', err.message);
    try {
      await bot.sendMessage(chatId, `Chưa tạo được báo giá. Lý do: ${err.message}`);
    } catch (_) {}
  }
});

log.info('Telegram bot đang chạy...');
