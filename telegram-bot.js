const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { config } = require('./services/config');
const { createScope } = require('./services/logger');
const { validatePayload } = require('./services/telegram-parser');
const { routeInput } = require('./services/input-router');
const { createRateLimiter } = require('./services/rate-limit');
const {
  shouldCancelFlow,
  getNextQuestion,
  parseAnswerValue,
  validatePendingAnswer,
  normalizePayloadBeforeQuestions,
  setPending,
  getPending,
  clearPending
} = require('./services/conversation-flow');
const TelegramBot = require('node-telegram-bot-api');

const execFileAsync = promisify(execFile);

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

async function preprocessImage(inputPath) {
  const outputPath = path.join(os.tmpdir(), `preprocessed-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  await execFileAsync('python3', [path.resolve(__dirname, 'services', 'image-preprocess.py'), inputPath, outputPath], {
    timeout: 120000,
    maxBuffer: 1024 * 1024 * 4
  });
  return outputPath;
}

async function continueWithPayload(chatId, payload, mode, sourceLabel = 'báo giá') {
  payload = normalizePayloadBeforeQuestions(payload);

  if (sourceLabel === 'ảnh' || sourceLabel === 'caption') {
    if (!(Number(payload.profitRate) > 0)) payload.profitRate = config.defaultProfitRate;
    if (!(Number(payload.vatPercent) > 0)) payload.vatPercent = config.defaultVatPercent;
  }

  const nextQuestion = getNextQuestion(payload);
  if (nextQuestion) {
    setPending(chatId, { payload, mode, sourceLabel, question: nextQuestion });
    await bot.sendMessage(chatId, nextQuestion.prompt);
    return;
  }

  const validationError = validatePayload(payload);
  if (validationError) {
    await bot.sendMessage(chatId, `Chưa tạo được báo giá. ${validationError}`);
    return;
  }

  log.info('Đang tạo báo giá', {
    chatId,
    customerName: payload.customer.name,
    itemCount: payload.items.length,
    parseMode: mode
  });

  await bot.sendMessage(chatId, `Em đang tạo báo giá cho ${payload.customer.name}...`);
  const { buffer, fileName } = await createQuotePdf(payload);
  await bot.sendDocument(
    chatId,
    buffer,
    {
      caption: `Báo giá đã tạo xong cho ${payload.customer.name}.\nLãi suất áp dụng: ${payload.profitRate}%.\nVAT áp dụng: ${payload.vatPercent}%.\nEm gửi file PDF đính kèm bên dưới.`
    },
    {
      filename: fileName,
      contentType: 'application/pdf'
    }
  );
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || msg.caption || '').trim();

  try {
    if (!text && !msg.photo) return;
    if (text.startsWith('/start')) return;

    if (text && shouldCancelFlow(text)) {
      clearPending(chatId);
      await bot.sendMessage(chatId, 'Em đã dừng tạo báo giá theo yêu cầu của Anh. Khi nào cần, Anh cứ nhắn em, em làm tiếp ngay. Hẹn gặp lại Anh Mạnh.');
      return;
    }

    if (!isAllowedChat(chatId)) {
      await bot.sendMessage(chatId, 'Chat này chưa được phép sử dụng bot.');
      return;
    }

    if (!rateLimit(String(chatId))) {
      await bot.sendMessage(chatId, 'Anh gửi hơi nhanh, vui lòng chờ một chút rồi thử lại.');
      return;
    }

    const pending = getPending(chatId);
    if (pending && text) {
      const answerError = validatePendingAnswer(pending.question, text);
      if (answerError) {
        await bot.sendMessage(chatId, answerError);
        await bot.sendMessage(chatId, pending.question.prompt);
        return;
      }

      const answer = parseAnswerValue(pending.question?.kind, text);
      pending.payload = normalizePayloadBeforeQuestions(pending.payload);
      
      switch (pending.question?.kind) {
        case 'customer.name':
          pending.payload.customer.name = String(answer || '');
          break;
        case 'item.unit':
          if (pending.payload.items[pending.question.index]) pending.payload.items[pending.question.index].unit = String(answer || '');
          break;
        case 'item.quantity':
          if (pending.payload.items[pending.question.index]) pending.payload.items[pending.question.index].quantity = Number(answer || 0);
          break;
        case 'item.costPrice':
          if (pending.payload.items[pending.question.index]) pending.payload.items[pending.question.index].costPrice = Number(answer || 0);
          break;
        case 'profitRate':
          pending.payload.profitRate = Number(answer || 0);
          break;
        case 'vatPercent':
          pending.payload.vatPercent = Number(answer || 0);
          break;
        case 'meta.deliveryDaysText': {
          const raw = String(text || '').trim();
          if (raw.length > 60 && /thanh toán|nghiệm thu|giao hàng|hồ sơ|kho của bên mua/i.test(raw)) {
            pending.payload.meta.deliveryPaymentClause = raw;
            pending.payload.meta.askTerms = false;
          } else {
            pending.payload.meta.deliveryDaysText = raw;
            pending.payload.meta.askTerms = true;
          }
          break;
        }
        case 'meta.paymentDaysText': {
          const raw = String(text || '').trim();
          if (raw.length > 60 && /thanh toán|nghiệm thu|giao hàng|hồ sơ|kho của bên mua/i.test(raw)) {
            pending.payload.meta.deliveryPaymentClause = raw;
            pending.payload.meta.askTerms = false;
          } else {
            pending.payload.meta.paymentDaysText = raw;
            pending.payload.meta.askTerms = true;
          }
          break;
        }
        case 'meta.warrantyMonthsText':
          pending.payload.meta.warrantyMonthsText = String(text || '').trim();
          pending.payload.meta.askTerms = true;
          break;
        case 'meta.quoteValidityDaysText':
          pending.payload.meta.quoteValidityDaysText = String(text || '').trim();
          pending.payload.meta.askTerms = true;
          break;
        case 'meta.signerChoice': {
          const normalized = String(text || '').trim();
          if (['1', '2', '3'].includes(normalized)) {
            pending.payload.meta.signerChoice = normalized;
          } else if (/duy/i.test(normalized)) {
            pending.payload.meta.signerChoice = '1';
          } else if (/xuyên|xuyen/i.test(normalized)) {
            pending.payload.meta.signerChoice = '2';
          } else {
            pending.payload.meta.signerChoice = '3';
          }
          break;
        }
        default:
          break;
      }

      clearPending(chatId);
      await continueWithPayload(chatId, pending.payload, `${pending.mode}-continued`, pending.sourceLabel);
      return;
    }

    await bot.sendMessage(chatId, 'Em đang phân tích dữ liệu báo giá, Anh chờ em một chút nhé.');

    let imageBuffer = null;
    let imagePath = null;
    let processedImagePath = null;

    if (Array.isArray(msg.photo) && msg.photo.length) {
      const bestPhoto = msg.photo[msg.photo.length - 1];
      const fileLink = await bot.getFileLink(bestPhoto.file_id);
      const imageResponse = await fetch(fileLink);
      const originalImageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      imagePath = path.join(os.tmpdir(), `telegram-photo-${Date.now()}.jpg`);
      fs.writeFileSync(imagePath, originalImageBuffer);
      processedImagePath = await preprocessImage(imagePath);
      imageBuffer = fs.readFileSync(processedImagePath);
    }

    const { payload, mode } = await routeInput({ text, imageBuffer, mimeType: 'image/jpeg' }, {
      defaultProfitRate: config.defaultProfitRate,
      defaultVatPercent: config.defaultVatPercent
    });

    if (imagePath && fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
    if (processedImagePath && fs.existsSync(processedImagePath)) fs.unlinkSync(processedImagePath);

    await continueWithPayload(chatId, payload, mode, imageBuffer ? 'ảnh' : 'text');
  } catch (err) {
    log.error('Lỗi bot Telegram', err.message);
    try {
      const msg = String(err?.message || '');
      if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.toLowerCase().includes('quota')) {
        await bot.sendMessage(chatId, 'Em đang tạm chạm giới hạn xử lý AI. Anh chờ em khoảng 1 phút rồi gửi lại giúp em nhé.');
      } else {
        await bot.sendMessage(chatId, 'Em đang gặp trục trặc khi xử lý báo giá. Anh thử gửi lại giúp em nhé.');
      }
    } catch (_) {}
  }
});

log.info('Telegram bot đang chạy...');
