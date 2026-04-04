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
const { getRecentQuotes, findQuotesByKeyword, findQuoteByNumber, getQuoteSource } = require('./services/history-store');
const {
  shouldCancelFlow,
  getNextQuestion,
  parseAnswerValue,
  validatePendingAnswer,
  normalizePayloadBeforeQuestions,
  buildPreviewMessage,
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

function buildQuoteActionMenu(quoteNumber) {
  const label = String(quoteNumber || '').padStart(3, '0');
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: `✏️ Sửa BG ${label}`, callback_data: `quote:edit:${label}` },
          { text: `👁 Review BG ${label}`, callback_data: `quote:review:${label}` }
        ],
        [
          { text: `📥 Tải PDF BG ${label}`, callback_data: `quote:pdf:${label}` }
        ],
        [
          { text: '⬅️ Quay lại menu chính', callback_data: 'quote:back' }
        ]
      ]
    }
  };
}

const mainMenu = {
  reply_markup: {
    keyboard: [
      ['📝 Tạo báo giá mới', '📂 Báo giá gần đây'],
      ['🔎 Tìm báo giá', '❓ Hướng dẫn']
    ],
    resize_keyboard: true,
    persistent: true
  }
};

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

function formatQuoteList(entries, title) {
  if (!entries.length) return `${title}\n\nChưa có dữ liệu.`;
  return [
    title,
    '',
    ...entries.map((entry, index) => {
      const when = String(entry.createdAt || '').replace('T', ' ').slice(0, 16);
      return `${index + 1}. BG ${entry.quoteNumber} | ${entry.customerName || 'Chưa rõ'} | ${entry.total || '0'} | ${when}`;
    })
  ].join('\n');
}

async function sendMainMenu(chatId, intro) {
  await bot.sendMessage(chatId, intro, mainMenu);
}

function findPdfPathByQuoteNumber(quoteNumber) {
  const sentDir = path.resolve(__dirname, 'output', 'sent');
  if (!fs.existsSync(sentDir)) return null;
  const prefix = `${String(quoteNumber).padStart(3, '0')}-`;
  const match = fs.readdirSync(sentDir).find((name) => name.startsWith(prefix) && name.endsWith('.pdf'));
  return match ? path.resolve(sentDir, match) : null;
}

function formatQuoteSummary(entry) {
  if (!entry) return 'Không tìm thấy báo giá.';
  const when = String(entry.createdAt || '').replace('T', ' ').slice(0, 16);
  return [
    `Thông tin báo giá BG ${String(entry.quoteNumber || '').padStart(3, '0')}:`,
    '',
    `• Khách hàng: ${entry.customerName || 'Chưa rõ'}`,
    `• Người nhận: ${entry.customerReceiver || 'Chưa rõ'}`,
    `• Số mặt hàng: ${entry.itemCount || 0}`,
    `• Tổng tiền: ${entry.total || '0'}`,
    `• Thời gian tạo: ${when}`,
    '',
    'Anh chọn thao tác ở menu bên dưới để tiếp tục.'
  ].join('\n');
}

function buildEditablePayloadFromSource(source, quoteNumber) {
  const payload = normalizePayloadBeforeQuestions(JSON.parse(JSON.stringify(source || {})));
  payload.quoteNumber = String(quoteNumber || payload.quoteNumber || '').padStart(3, '0');
  return payload;
}

function isGreetingOnly(text) {
  const normalized = String(text || '').trim().toLowerCase();
  return ['hi', 'hello', 'helo', 'hey', 'alo', 'xin chào', 'chào', 'start'].includes(normalized);
}

function looksLikeQuoteInput(text, hasPhoto) {
  if (hasPhoto) return true;
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (raw.length >= 25) return true;
  return /(khách hàng|người nhận|bộ phận|điện thoại|email|hàng hóa|lãi|vat|báo giá|china|cái|bộ|chiếc|đơn vị|số lượng|giá nhập)/i.test(raw);
}

function applyQuickPreviewEdit(payload, text) {
  const raw = String(text || '').trim();
  const normalized = raw.toLowerCase();
  payload.customer = payload.customer || {};
  payload.meta = payload.meta || {};

  let match = normalized.match(/^lãi\s*(suất)?\s*[: ]?\s*(\d+(?:[.,]\d+)?)%?$/i);
  if (match) {
    payload.profitRate = Number(match[2].replace(',', '.'));
    return true;
  }

  match = normalized.match(/^vat\s*[: ]?\s*(\d+(?:[.,]\d+)?)%?$/i);
  if (match) {
    payload.vatPercent = Number(match[1].replace(',', '.'));
    return true;
  }

  match = raw.match(/^người ký\s*[: ]?\s*(.+)$/i);
  if (match) {
    const value = match[1].trim();
    if (['1', '2', '3'].includes(value)) payload.meta.signerChoice = value;
    else if (/duy/i.test(value)) payload.meta.signerChoice = '1';
    else if (/xuyên|xuyen/i.test(value)) payload.meta.signerChoice = '2';
    else if (/đạt|dat/i.test(value)) payload.meta.signerChoice = '3';
    return true;
  }

  match = raw.match(/^(khách hàng|đơn vị)\s*[: ]?\s*(.+)$/i);
  if (match) {
    payload.customer.name = match[2].trim();
    return true;
  }

  return false;
}

bot.onText(/\/start/i, async (msg) => {
  if (!isAllowedChat(msg.chat.id)) {
    await bot.sendMessage(msg.chat.id, 'Chat này chưa được phép sử dụng bot.');
    return;
  }

  await sendMainMenu(
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

async function finalizeQuote(chatId, payload, mode) {
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

async function continueWithPayload(chatId, payload, mode, sourceLabel = 'báo giá') {
  payload = normalizePayloadBeforeQuestions(payload);

  if (sourceLabel === 'ảnh' || sourceLabel === 'caption') {
    if (!(Number(payload.profitRate) > 0)) payload.profitRate = config.defaultProfitRate;
    if (!(Number(payload.vatPercent) > 0)) payload.vatPercent = config.defaultVatPercent;
  }

  const nextQuestion = getNextQuestion(payload);
  if (nextQuestion) {
    setPending(chatId, { type: 'question', payload, mode, sourceLabel, question: nextQuestion });
    await bot.sendMessage(chatId, nextQuestion.prompt);
    return;
  }

  setPending(chatId, { type: 'preview', payload, mode, sourceLabel });
  await bot.sendMessage(chatId, buildPreviewMessage(payload), {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Xuất PDF', callback_data: 'preview:ok' }
        ]
      ]
    }
  });
}

bot.on('callback_query', async (query) => {
  const chatId = query.message?.chat?.id;
  const data = String(query.data || '');
  if (!chatId || !data) return;

  try {
    const pending = getPending(chatId);

    if (data === 'preview:ok' && pending?.type === 'preview') {
      clearPending(chatId);
      await bot.answerCallbackQuery(query.id, { text: 'Đang xuất PDF...' });
      await finalizeQuote(chatId, pending.payload, `${pending.mode}-preview-approved`);
      return;
    }

    if (data === 'quote:back') {
      clearPending(chatId);
      await bot.answerCallbackQuery(query.id, { text: 'Đã quay lại menu chính' });
      await sendMainMenu(chatId, 'Đã quay lại menu chính.');
      return;
    }

    const quoteMatch = data.match(/^quote:(edit|review|pdf):(\d{3})$/);
    if (quoteMatch) {
      const [, action, quoteNumber] = quoteMatch;
      setPending(chatId, { type: 'quote-view', quoteNumber });

      if (action === 'review') {
        await bot.answerCallbackQuery(query.id, { text: `Đang mở BG ${quoteNumber}` });
        await bot.sendMessage(chatId, formatQuoteSummary(findQuoteByNumber(quoteNumber)), buildQuoteActionMenu(quoteNumber));
        return;
      }

      if (action === 'pdf') {
        const pdfPath = findPdfPathByQuoteNumber(quoteNumber);
        if (!pdfPath) {
          await bot.answerCallbackQuery(query.id, { text: 'Chưa tìm thấy PDF', show_alert: false });
          await bot.sendMessage(chatId, 'Em chưa tìm thấy file PDF của báo giá này.', buildQuoteActionMenu(quoteNumber));
          return;
        }
        await bot.answerCallbackQuery(query.id, { text: `Đang gửi PDF BG ${quoteNumber}` });
        await bot.sendDocument(chatId, pdfPath, { caption: `Em gửi lại PDF của BG ${quoteNumber}.` }, { filename: path.basename(pdfPath), contentType: 'application/pdf' });
        return;
      }

      if (action === 'edit') {
        const source = getQuoteSource(quoteNumber);
        if (!source) {
          await bot.answerCallbackQuery(query.id, { text: 'Chưa có dữ liệu gốc để sửa', show_alert: false });
          await bot.sendMessage(chatId, 'Em chưa tìm thấy dữ liệu gốc để sửa báo giá này. Các báo giá tạo từ bây giờ sẽ hỗ trợ sửa đầy đủ hơn.', buildQuoteActionMenu(quoteNumber));
          return;
        }
        await bot.answerCallbackQuery(query.id, { text: `Đang mở sửa BG ${quoteNumber}` });
        clearPending(chatId);
        await continueWithPayload(chatId, buildEditablePayloadFromSource(source, quoteNumber), 'edit-existing-quote', 'text');
        return;
      }
    }

    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    log.error('Lỗi callback Telegram', err.message);
    try { await bot.answerCallbackQuery(query.id, { text: 'Có lỗi xảy ra, Anh thử lại giúp em nhé.', show_alert: false }); } catch (_) {}
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || msg.caption || '').trim();

  try {
    if (!text && !msg.photo) return;
    if (text.startsWith('/start')) return;

    if (text.startsWith('/menu')) {
      clearPending(chatId);
      await sendMainMenu(chatId, 'Đây là menu chính của bot báo giá CTC.');
      return;
    }

    if (text.startsWith('/status')) {
      clearPending(chatId);
      await bot.sendMessage(chatId, 'Bot báo giá CTC đang online bình thường.', mainMenu);
      return;
    }

    if (text.startsWith('/')) {
      await bot.sendMessage(chatId, 'Lệnh này hiện chưa hỗ trợ trong bot báo giá. Anh dùng /start hoặc /menu giúp em nhé.', mainMenu);
      return;
    }

    if (isGreetingOnly(text)) {
      clearPending(chatId);
      await sendMainMenu(chatId, 'Anh nhắn /start, /menu, hi hoặc hello để bắt đầu nhé.\nHoặc Anh gửi luôn nội dung báo giá, ảnh, hoặc ảnh + caption, em sẽ xử lý.\nKhi bot hiện bản xem trước, Anh nhắn ok là em xuất PDF.');
      return;
    }

    if (text === '⬅️ Quay lại menu chính') {
      clearPending(chatId);
      await sendMainMenu(chatId, 'Đã quay lại menu chính.');
      return;
    }

    if (text === '📝 Tạo báo giá mới') {
      clearPending(chatId);
      await bot.sendMessage(chatId, 'Anh gửi nội dung báo giá dạng text, ảnh hoặc ảnh + caption để em xử lý nhé.', mainMenu);
      return;
    }

    if (text === '📂 Báo giá gần đây') {
      clearPending(chatId);
      await bot.sendMessage(chatId, formatQuoteList(getRecentQuotes(10), '10 báo giá gần đây'), mainMenu);
      return;
    }

    if (text === '🔎 Tìm báo giá') {
      clearPending(chatId);
      setPending(chatId, { type: 'search-quote' });
      await bot.sendMessage(chatId, 'Anh nhập số BG hoặc tên khách hàng để em tìm nhé.', mainMenu);
      return;
    }

    if (text === '❓ Hướng dẫn') {
      clearPending(chatId);
      await bot.sendMessage(chatId, 'Anh nhắn /start, /menu, hi hoặc hello để bắt đầu nhé.\nHoặc Anh gửi luôn nội dung báo giá, ảnh, hoặc ảnh + caption, em sẽ xử lý.\nKhi bot hiện bản xem trước, Anh nhắn ok là em xuất PDF.', mainMenu);
      return;
    }

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
      if (pending.type === 'quote-view' && /^(⬅️\s*)?quay lại( menu chính)?$/i.test(text.trim())) {
        clearPending(chatId);
        await sendMainMenu(chatId, 'Đã quay lại menu chính.');
        return;
      }

      if (pending.type === 'quote-view' && /^👁\s*review (báo giá|bg)( \d+)?$|^review$|^xem$/i.test(text.trim())) {
        const entry = findQuoteByNumber(pending.quoteNumber);
        await bot.sendMessage(chatId, formatQuoteSummary(entry), buildQuoteActionMenu(pending.quoteNumber));
        return;
      }

      if (pending.type === 'quote-view' && /^📥\s*tải pdf( bg \d+)?$|^tải pdf$|^pdf$/i.test(text.trim())) {
        const pdfPath = findPdfPathByQuoteNumber(pending.quoteNumber);
        if (!pdfPath) {
          await bot.sendMessage(chatId, 'Em chưa tìm thấy file PDF của báo giá này.', buildQuoteActionMenu(pending.quoteNumber));
          return;
        }
        await bot.sendDocument(chatId, pdfPath, { caption: `Em gửi lại PDF của BG ${String(pending.quoteNumber).padStart(3, '0')}.` }, { filename: path.basename(pdfPath), contentType: 'application/pdf' });
        return;
      }

      if (pending.type === 'quote-view' && /^✏️\s*sửa (báo giá|bg)( \d+)?$|^sửa$/i.test(text.trim())) {
        const source = getQuoteSource(pending.quoteNumber);
        if (!source) {
          clearPending(chatId);
          await bot.sendMessage(chatId, 'Em chưa tìm thấy dữ liệu gốc để sửa báo giá này. Các báo giá tạo từ bây giờ sẽ hỗ trợ sửa đầy đủ hơn.', buildQuoteActionMenu(pending.quoteNumber));
          return;
        }
        clearPending(chatId);
        await continueWithPayload(chatId, buildEditablePayloadFromSource(source, pending.quoteNumber), 'edit-existing-quote', 'text');
        return;
      }

      if (pending.type === 'search-quote') {
        const exact = findQuoteByNumber(text);
        clearPending(chatId);
        if (exact) {
          setPending(chatId, { type: 'quote-view', quoteNumber: exact.quoteNumber });
          await bot.sendMessage(chatId, formatQuoteSummary(exact), buildQuoteActionMenu(exact.quoteNumber));
          return;
        }
        const results = findQuotesByKeyword(text, 10);
        await bot.sendMessage(chatId, formatQuoteList(results, `Kết quả tìm cho: ${text}`), mainMenu);
        return;
      }

      if (pending.type === 'preview') {
        const trimmed = text.trim();
        if (/^(ok|oke|ok em|ok rồi|xuất|xuất file|tạo pdf)$/i.test(trimmed)) {
          clearPending(chatId);
          await finalizeQuote(chatId, pending.payload, `${pending.mode}-preview-approved`);
          return;
        }

        const previewQuestions = {
          '1': { kind: 'customer.name', prompt: 'Anh muốn sửa tên khách hàng thành gì để em cập nhật lại preview?' },
          '3': { kind: 'profitRate', prompt: 'Anh muốn sửa lãi suất thành bao nhiêu (%)?' },
          '4': { kind: 'vatPercent', prompt: 'Anh muốn sửa VAT thành bao nhiêu (%)?' },
          '5': { kind: 'meta.signerChoice', prompt: 'Anh muốn đổi người ký nào? Nhập 1, 2 hoặc 3 giúp em nhé.' },
          '6': { kind: 'meta.paymentDaysText', prompt: 'Anh gửi giúp em điều khoản / nội dung chính mới để em cập nhật lại preview nhé.' }
        };

        if (previewQuestions[trimmed]) {
          setPending(chatId, {
            type: 'question',
            payload: pending.payload,
            mode: pending.mode,
            sourceLabel: pending.sourceLabel,
            question: previewQuestions[trimmed]
          });
          await bot.sendMessage(chatId, previewQuestions[trimmed].prompt);
          return;
        }

        if (trimmed === '2') {
          await bot.sendMessage(chatId, 'Số mặt hàng hiện chưa hỗ trợ sửa nhanh bằng STT ở bản này. Anh sửa báo giá cũ sâu hơn em làm tiếp cho Anh sau nhé.');
          await bot.sendMessage(chatId, buildPreviewMessage(pending.payload));
          return;
        }

        if (applyQuickPreviewEdit(pending.payload, text)) {
          setPending(chatId, pending);
          await bot.sendMessage(chatId, buildPreviewMessage(pending.payload));
          return;
        }

        await bot.sendMessage(chatId, 'Anh nhắn ok để xuất, hoặc nhắn số 1, 3, 4, 5, 6 để sửa nhanh trên preview nhé.');
        return;
      }

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

    const directQuoteLookup = findQuoteByNumber(text);
    if (directQuoteLookup) {
      setPending(chatId, { type: 'quote-view', quoteNumber: directQuoteLookup.quoteNumber });
      await bot.sendMessage(chatId, formatQuoteSummary(directQuoteLookup), buildQuoteActionMenu(directQuoteLookup.quoteNumber));
      return;
    }

    if (text === '🔎 Tìm báo giá') {
      setPending(chatId, { type: 'search-quote' });
      await bot.sendMessage(chatId, 'Anh nhập số BG hoặc tên khách hàng để em tìm nhé.', mainMenu);
      return;
    }

    if (!looksLikeQuoteInput(text, Boolean(msg.photo))) {
      await sendMainMenu(chatId, 'Anh nhắn /start, /menu, hi hoặc hello để bắt đầu nhé.\nHoặc Anh gửi luôn nội dung báo giá, ảnh, hoặc ảnh + caption, em sẽ xử lý.\nKhi bot hiện bản xem trước, Anh nhắn ok là em xuất PDF.');
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
