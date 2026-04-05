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
const { getRecentQuotes, getQuotesByUser, findQuotesByKeyword, findQuoteByNumber, getQuoteSource } = require('./services/history-store');
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
const {
  buildQuoteActionMenu,
  buildMainMenu,
  buildQuotePickKeyboard,
  formatQuotePickerIntro,
  formatQuoteSummary,
  formatEditableItemLine,
  buildPreviewInlineKeyboard
} = require('./services/telegram-ui');
const {
  sendItemEditList,
  buildAddItemQuestion,
  buildItemEditFieldState,
  buildItemEditFieldPrompt
} = require('./services/item-edit-flow');
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
const ADMIN_TELEGRAM_ID = String(config.telegramAdminId || '').trim();

function isAdminUser(msgOrUserId) {
  if (!ADMIN_TELEGRAM_ID) return false;
  const userId = typeof msgOrUserId === 'object' ? msgOrUserId?.from?.id : msgOrUserId;
  return String(userId || '') === ADMIN_TELEGRAM_ID;
}

function ensureAdmin(chatId, userId) {
  if (isAdminUser(userId)) return true;
  log.warn('Từ chối quyền admin', { chatId, userId: String(userId || '') });
  bot.sendMessage(chatId, 'Chức năng này chỉ dành cho admin.', buildMainMenuForUser(userId));
  return false;
}

function canAccessQuote(userId, entry) {
  if (!entry) return false;
  if (isAdminUser(userId)) return true;
  return String(entry.createdBy || '') === String(userId || '');
}

async function ensureQuoteAccess(chatId, userId, entry) {
  if (canAccessQuote(userId, entry)) return true;
  log.warn('Từ chối truy cập báo giá', {
    chatId,
    userId: String(userId || ''),
    quoteNumber: String(entry?.quoteNumber || '').padStart(3, '0'),
    ownerId: String(entry?.createdBy || '')
  });
  await bot.sendMessage(chatId, 'Anh chỉ có quyền xem và thao tác với các báo giá do chính mình tạo.', buildMainMenuForUser(userId));
  return false;
}

function buildMainMenuForUser(userId) {
  return buildMainMenu(isAdminUser(userId));
}

function isAllowedChat(chatId) {
  if (!config.telegramAllowedChatIds.length) return true;
  return config.telegramAllowedChatIds.includes(String(chatId));
}

async function createQuotePdf(payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.renderTimeoutMs);
  const startedAt = Date.now();

  try {
    log.info('Gọi API tạo báo giá', {
      customerName: payload?.customer?.name || '',
      itemCount: Array.isArray(payload?.items) ? payload.items.length : 0,
      profitRate: payload?.profitRate,
      vatPercent: payload?.vatPercent
    });
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
    log.info('API tạo báo giá thành công', {
      fileName,
      durationMs: Date.now() - startedAt
    });
    return { buffer: Buffer.from(arrayBuffer), fileName };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendQuotePicker(chatId, allEntries, title, userId = chatId, options = {}) {
  const pageSize = Math.max(1, options.pageSize || config.quoteListLimit || 10);
  const page = Math.max(0, Number(options.page || 0));
  const mode = options.mode || 'recent';
  const keyword = options.keyword || '';
  const total = allEntries.length;
  const start = page * pageSize;
  const entries = allEntries.slice(start, start + pageSize);
  const intro = formatQuotePickerIntro(total, title, page, pageSize);

  await bot.sendMessage(chatId, intro, {
    reply_markup: entries.length
      ? buildQuotePickKeyboard(entries, { page, pageSize, total, mode, keyword })
      : buildMainMenuForUser(userId).reply_markup
  });
}

async function sendMainMenu(chatId, intro, userId = chatId) {
  await bot.sendMessage(chatId, intro, buildMainMenuForUser(userId));
}

function findPdfPathByQuoteNumber(quoteNumber) {
  const sentDir = path.resolve(__dirname, 'output', 'sent');
  if (!fs.existsSync(sentDir)) return null;
  const prefix = `${String(quoteNumber).padStart(3, '0')}-`;
  const match = fs.readdirSync(sentDir).find((name) => name.startsWith(prefix) && name.endsWith('.pdf'));
  return match ? path.resolve(sentDir, match) : null;
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

function attachTelegramUserMeta(payload, msg) {
  payload.meta = payload.meta || {};
  payload.meta.createdBy = String(msg?.from?.id || '');
  payload.meta.createdByName = [msg?.from?.first_name, msg?.from?.last_name].filter(Boolean).join(' ').trim() || msg?.from?.username || '';
  payload.meta.createdByUsername = msg?.from?.username || '';
  return payload;
}

async function finalizeQuote(chatId, payload, mode) {
  payload = normalizePayloadBeforeQuestions(payload || {});
  payload.customer = payload.customer || {};
  payload.items = Array.isArray(payload.items) ? payload.items : [];

  const validationError = validatePayload(payload);
  if (validationError) {
    log.warn('Không thể xuất PDF do payload chưa hợp lệ', {
      chatId,
      parseMode: mode,
      customerName: payload?.customer?.name || '',
      itemCount: Array.isArray(payload?.items) ? payload.items.length : 0,
      validationError
    });
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
    reply_markup: buildPreviewInlineKeyboard()
  });
}

bot.on('callback_query', async (query) => {
  const chatId = query.message?.chat?.id;
  const data = String(query.data || '');
  if (!chatId || !data) return;

  try {
    const pending = getPending(chatId);
    const userId = query.from?.id;
    log.info('Nhận callback Telegram', {
      chatId,
      userId: String(userId || ''),
      callback: data,
      pendingType: pending?.type || ''
    });

    if (data === 'preview:ok' && pending?.type === 'preview') {
      clearPending(chatId);
      await bot.answerCallbackQuery(query.id, { text: 'Đang xuất PDF...' });
      await finalizeQuote(chatId, pending.payload, `${pending.mode}-preview-approved`);
      return;
    }

    if (data === 'item:back:preview' && pending?.payload) {
      await bot.answerCallbackQuery(query.id, { text: 'Đã quay lại preview' });
      await continueWithPayload(chatId, pending.payload, pending.mode || 'preview-return', pending.sourceLabel || 'text');
      return;
    }

    if (data === 'item:add' && pending?.payload) {
      await bot.answerCallbackQuery(query.id, { text: 'Thêm sản phẩm mới' });
      setPending(chatId, buildAddItemQuestion(pending.payload, pending));
      await bot.sendMessage(chatId, 'Anh gửi giúp em tên sản phẩm mới để em thêm dòng nhé.');
      return;
    }

    if (data === 'item:edit:list' && pending?.payload) {
      await bot.answerCallbackQuery(query.id, { text: 'Chọn dòng cần sửa' });
      await sendItemEditList({ bot, setPending, chatId, payload: pending.payload, mode: pending.mode, sourceLabel: pending.sourceLabel, action: 'edit' });
      return;
    }

    if (data === 'item:delete:list' && pending?.payload) {
      await bot.answerCallbackQuery(query.id, { text: 'Chọn dòng cần xóa' });
      await sendItemEditList({ bot, setPending, chatId, payload: pending.payload, mode: pending.mode, sourceLabel: pending.sourceLabel, action: 'delete' });
      return;
    }

    const itemEditMatch = data.match(/^item:edit:(\d+)$/);
    if (itemEditMatch && pending?.payload) {
      const itemIndex = Number(itemEditMatch[1]);
      if (!pending.payload?.items?.[itemIndex]) {
        await bot.answerCallbackQuery(query.id, { text: 'Không thấy dòng cần sửa', show_alert: false });
        return;
      }
      await bot.answerCallbackQuery(query.id, { text: `Đang sửa dòng ${itemIndex + 1}` });
      setPending(chatId, buildItemEditFieldState(pending.payload, pending, itemIndex));
      await bot.sendMessage(chatId, buildItemEditFieldPrompt(pending.payload, itemIndex));
      return;
    }

    const itemDeleteMatch = data.match(/^item:delete:(\d+)$/);
    if (itemDeleteMatch && pending?.payload) {
      const itemIndex = Number(itemDeleteMatch[1]);
      if (!pending.payload?.items?.[itemIndex]) {
        await bot.answerCallbackQuery(query.id, { text: 'Không thấy dòng cần xóa', show_alert: false });
        return;
      }
      const removed = pending.payload.items.splice(itemIndex, 1)[0];
      await bot.answerCallbackQuery(query.id, { text: `Đã xóa dòng ${itemIndex + 1}` });
      await bot.sendMessage(chatId, `Em đã xóa dòng ${itemIndex + 1}: ${removed?.description || 'Chưa rõ tên sản phẩm'}.`);
      await continueWithPayload(chatId, pending.payload, pending.mode || 'item-delete', pending.sourceLabel || 'text');
      return;
    }

    if (data === 'quote:back') {
      clearPending(chatId);
      await bot.answerCallbackQuery(query.id, { text: 'Đã quay lại menu chính' });
      await sendMainMenu(chatId, 'Đã quay lại menu chính.');
      return;
    }

    const quoteListMatch = data.match(/^quote:list:(recent|mine|search):(\d+):(.*)$/);
    if (quoteListMatch) {
      const [, listMode, pageRaw, keywordEncoded] = quoteListMatch;
      const page = Number(pageRaw || 0);
      const keyword = decodeURIComponent(keywordEncoded || '');
      let entries = [];
      let title = '';

      if (listMode === 'recent') {
        if (!ensureAdmin(chatId, userId)) {
          await bot.answerCallbackQuery(query.id, { text: 'Chức năng này chỉ dành cho admin', show_alert: false });
          return;
        }
        entries = getRecentQuotes(500);
        title = 'Báo giá gần đây';
      } else if (listMode === 'mine') {
        entries = getQuotesByUser(userId, 500);
        if (!entries.length && isAdminUser(userId)) entries = getRecentQuotes(500);
        title = 'Báo giá của tôi';
      } else {
        const results = findQuotesByKeyword(keyword, 500);
        entries = isAdminUser(userId)
          ? results
          : results.filter((entry) => String(entry.createdBy || '') === String(userId || ''));
        title = `Kết quả tìm cho: ${keyword}`;
      }

      await bot.answerCallbackQuery(query.id, { text: `Trang ${page + 1}` });
      await sendQuotePicker(chatId, entries, title, userId, { page, mode: listMode, keyword });
      return;
    }

    const quoteOpenMatch = data.match(/^quote:open:(\d{3})$/);
    if (quoteOpenMatch) {
      const quoteNumber = quoteOpenMatch[1];
      const entry = findQuoteByNumber(quoteNumber);
      if (!(await ensureQuoteAccess(chatId, userId, entry))) {
        await bot.answerCallbackQuery(query.id, { text: 'Không có quyền truy cập', show_alert: false });
        return;
      }
      setPending(chatId, { type: 'quote-view', quoteNumber });
      await bot.answerCallbackQuery(query.id, { text: `Đang mở BG ${quoteNumber}` });
      await bot.sendMessage(chatId, formatQuoteSummary(entry), buildQuoteActionMenu(quoteNumber));
      return;
    }

    const quoteMatch = data.match(/^quote:(edit|review|pdf):(\d{3})$/);
    if (quoteMatch) {
      const [, action, quoteNumber] = quoteMatch;
      setPending(chatId, { type: 'quote-view', quoteNumber });

      const entry = findQuoteByNumber(quoteNumber);
      if (!(await ensureQuoteAccess(chatId, userId, entry))) {
        await bot.answerCallbackQuery(query.id, { text: 'Không có quyền truy cập', show_alert: false });
        return;
      }

      if (action === 'review') {
        await bot.answerCallbackQuery(query.id, { text: `Đang mở BG ${quoteNumber}` });
        await bot.sendMessage(chatId, formatQuoteSummary(entry), buildQuoteActionMenu(quoteNumber));
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
    log.info('Nhận message Telegram', {
      chatId,
      userId: String(msg?.from?.id || ''),
      username: msg?.from?.username || '',
      hasPhoto: Boolean(msg?.photo?.length),
      hasCaption: Boolean(msg?.caption),
      textPreview: text.slice(0, 120)
    });
    if (!text && !msg.photo) return;
    if (text.startsWith('/start')) return;

    if (text.startsWith('/menu')) {
      clearPending(chatId);
      await sendMainMenu(chatId, 'Đây là menu chính của bot báo giá CTC.');
      return;
    }

    if (text.startsWith('/status')) {
      clearPending(chatId);
      await bot.sendMessage(chatId, 'Bot báo giá CTC đang online bình thường.', buildMainMenuForUser(chatId));
      return;
    }

    if (text.startsWith('/')) {
      await bot.sendMessage(chatId, 'Lệnh này hiện chưa hỗ trợ trong bot báo giá. Anh dùng /start hoặc /menu giúp em nhé.', buildMainMenuForUser(chatId));
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
      await bot.sendMessage(chatId, 'Anh nhắn /start, /menu, hi hoặc hello để bắt đầu nhé.\nHoặc Anh gửi luôn nội dung báo giá, ảnh, hoặc ảnh + caption, em sẽ xử lý.\nKhi bot hiện bản xem trước, Anh nhắn ok là em xuất PDF.', buildMainMenuForUser(chatId));
      return;
    }

    if (text === '📂 Báo giá gần đây') {
      clearPending(chatId);
      if (!ensureAdmin(chatId, msg.from?.id)) return;
      await sendQuotePicker(chatId, getRecentQuotes(500), 'Báo giá gần đây', msg.from?.id, { page: 0, mode: 'recent' });
      return;
    }

    if (text === '📁 Báo giá của tôi') {
      clearPending(chatId);
      let myQuotes = getQuotesByUser(msg.from?.id, 500);
      if (!myQuotes.length && isAdminUser(msg)) {
        myQuotes = getRecentQuotes(500);
      }
      await sendQuotePicker(chatId, myQuotes, 'Báo giá của tôi', msg.from?.id, { page: 0, mode: 'mine' });
      return;
    }

    if (text === '🔎 Tìm báo giá') {
      clearPending(chatId);
      if (!ensureAdmin(chatId, msg.from?.id)) return;
      setPending(chatId, { type: 'search-quote' });
      await bot.sendMessage(chatId, 'Anh nhập số BG hoặc tên khách hàng để em tìm nhé.', buildMainMenuForUser(chatId));
      return;
    }

    if (text === '❓ Hướng dẫn') {
      clearPending(chatId);
      await bot.sendMessage(chatId, 'Anh nhắn /start, /menu, hi hoặc hello để bắt đầu nhé.\nHoặc Anh gửi luôn nội dung báo giá, ảnh, hoặc ảnh + caption, em sẽ xử lý.\nKhi bot hiện bản xem trước, Anh nhắn ok là em xuất PDF.', buildMainMenuForUser(chatId));
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
      log.warn('Bị rate limit Telegram', { chatId, userId: String(msg?.from?.id || '') });
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
        if (!(await ensureQuoteAccess(chatId, msg.from?.id, entry))) return;
        await bot.sendMessage(chatId, formatQuoteSummary(entry), buildQuoteActionMenu(pending.quoteNumber));
        return;
      }

      if (pending.type === 'quote-view' && /^📥\s*tải pdf( bg \d+)?$|^tải pdf$|^pdf$/i.test(text.trim())) {
        const entry = findQuoteByNumber(pending.quoteNumber);
        if (!(await ensureQuoteAccess(chatId, msg.from?.id, entry))) return;
        const pdfPath = findPdfPathByQuoteNumber(pending.quoteNumber);
        if (!pdfPath) {
          await bot.sendMessage(chatId, 'Em chưa tìm thấy file PDF của báo giá này.', buildQuoteActionMenu(pending.quoteNumber));
          return;
        }
        await bot.sendDocument(chatId, pdfPath, { caption: `Em gửi lại PDF của BG ${String(pending.quoteNumber).padStart(3, '0')}.` }, { filename: path.basename(pdfPath), contentType: 'application/pdf' });
        return;
      }

      if (pending.type === 'quote-view' && /^✏️\s*sửa (báo giá|bg)( \d+)?$|^sửa$/i.test(text.trim())) {
        const entry = findQuoteByNumber(pending.quoteNumber);
        if (!(await ensureQuoteAccess(chatId, msg.from?.id, entry))) return;
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
          if (!(await ensureQuoteAccess(chatId, msg.from?.id, exact))) return;
          setPending(chatId, { type: 'quote-view', quoteNumber: exact.quoteNumber });
          await bot.sendMessage(chatId, formatQuoteSummary(exact), buildQuoteActionMenu(exact.quoteNumber));
          return;
        }
        const results = findQuotesByKeyword(text, 500);
        const scopedResults = isAdminUser(msg.from?.id)
          ? results
          : results.filter((entry) => String(entry.createdBy || '') === String(msg.from?.id || ''));
        await sendQuotePicker(chatId, scopedResults, `Kết quả tìm cho: ${text}`, msg.from?.id, { page: 0, mode: 'search', keyword: text });
        return;
      }

      if (pending.type === 'item-edit-select') {
        const trimmed = text.trim();
        const addMatch = trimmed.match(/^thêm(?:\s*[:\-]?\s*(.+))?$/i);
        const deleteMatch = trimmed.match(/^(xóa|xoa|xoá)\s+(\d+)$/i);

        if (addMatch) {
          const description = (addMatch[1] || '').trim();
          const nextIndex = Array.isArray(pending.payload?.items) ? pending.payload.items.length : 0;
          const question = {
            kind: 'item.add.description',
            index: nextIndex,
            prompt: description
              ? `Em đã nhận tên mặt hàng mới: ${description}\nAnh cho em xuất xứ của mặt hàng này nhé?`
              : 'Anh gửi giúp em tên sản phẩm mới để em thêm dòng nhé.'
          };
          if (description) {
            pending.payload.items = Array.isArray(pending.payload.items) ? pending.payload.items : [];
            pending.payload.items.push({
              description,
              origin: '',
              unit: '',
              quantity: 0,
              costPrice: 0,
              productContent: ''
            });
            question.kind = 'item.add.origin';
          }
          setPending(chatId, {
            type: 'question',
            payload: pending.payload,
            mode: pending.mode,
            sourceLabel: pending.sourceLabel,
            question
          });
          await bot.sendMessage(chatId, question.prompt);
          return;
        }

        if (deleteMatch) {
          const rowIndex = Number(deleteMatch[2]) - 1;
          if (!Number.isInteger(rowIndex) || rowIndex < 0 || !pending.payload?.items?.[rowIndex]) {
            await bot.sendMessage(chatId, 'Dòng hàng cần xóa chưa hợp lệ. Anh nhập lại theo dạng: xóa 1');
            return;
          }
          const removed = pending.payload.items.splice(rowIndex, 1)[0];
          if (!pending.payload.items.length) {
            pending.payload.items.push({ description: '', origin: '', unit: '', quantity: 0, costPrice: 0, productContent: '' });
          }
          await bot.sendMessage(chatId, `Em đã xóa dòng ${rowIndex + 1}: ${removed?.description || 'Chưa rõ tên sản phẩm'}.`);
          await continueWithPayload(chatId, pending.payload, pending.mode, pending.sourceLabel);
          return;
        }

        const rowIndex = Number(trimmed) - 1;
        if (!Number.isInteger(rowIndex) || rowIndex < 0 || !pending.payload?.items?.[rowIndex]) {
          await bot.sendMessage(chatId, 'Dòng hàng chưa hợp lệ. Anh nhập lại số dòng giúp em nhé, hoặc nhắn "thêm" / "xóa 1".');
          return;
        }
        setPending(chatId, {
          type: 'item-edit-field',
          payload: pending.payload,
          mode: pending.mode,
          sourceLabel: pending.sourceLabel,
          itemIndex: rowIndex
        });
        const item = pending.payload.items[rowIndex];
        await bot.sendMessage(chatId, `Anh đang sửa dòng ${rowIndex + 1}:\n${formatEditableItemLine(item, rowIndex)}\n\nAnh muốn sửa gì?\n1. Tên sản phẩm\n2. Giá đầu vào\n3. Số lượng\n4. Đơn vị\n5. Xuất xứ`);
        return;
      }

      if (pending.type === 'item-edit-field') {
        const itemIndex = pending.itemIndex;
        if (!pending.payload?.items?.[itemIndex]) {
          await bot.sendMessage(chatId, 'Em không thấy dòng hàng cần sửa.');
          await continueWithPayload(chatId, pending.payload, pending.mode, pending.sourceLabel);
          return;
        }
        let question = null;
        const item = pending.payload.items[itemIndex];
        if (text.trim() === '1') {
          question = {
            kind: 'item.description',
            index: itemIndex,
            prompt: `Anh muốn sửa tên sản phẩm:\n${item.description || 'Chưa rõ tên sản phẩm'}\nthành gì?`
          };
        } else if (text.trim() === '2') {
          question = {
            kind: 'item.costPrice',
            index: itemIndex,
            prompt: `Anh muốn sửa giá đầu vào của sản phẩm:\n${itemIndex + 1}. ${item.description || 'Chưa rõ tên sản phẩm'}\nGiá hiện tại: ${Number(item.costPrice || 0).toLocaleString('vi-VN')}\nthành bao nhiêu?`
          };
        } else if (text.trim() === '3') {
          question = {
            kind: 'item.quantity',
            index: itemIndex,
            prompt: `Anh muốn sửa số lượng của sản phẩm:\n${itemIndex + 1}. ${item.description || 'Chưa rõ tên sản phẩm'}\nSố lượng hiện tại: ${Number(item.quantity || 0).toLocaleString('vi-VN')}\nthành bao nhiêu?`
          };
        } else if (text.trim() === '4') {
          question = {
            kind: 'item.unit',
            index: itemIndex,
            prompt: `Anh muốn sửa đơn vị tính của sản phẩm:\n${itemIndex + 1}. ${item.description || 'Chưa rõ tên sản phẩm'}\nĐơn vị hiện tại: ${item.unit || 'Chưa rõ'}\nthành gì?`
          };
        } else if (text.trim() === '5') {
          question = {
            kind: 'item.origin',
            index: itemIndex,
            prompt: `Anh muốn sửa xuất xứ của sản phẩm:\n${itemIndex + 1}. ${item.description || 'Chưa rõ tên sản phẩm'}\nXuất xứ hiện tại: ${item.origin || 'Chưa rõ'}\nthành gì?`
          };
        } else {
          await bot.sendMessage(chatId, 'Anh chọn 1 tên sản phẩm, 2 giá đầu vào, 3 số lượng, 4 đơn vị, hoặc 5 xuất xứ nhé.');
          return;
        }
        setPending(chatId, {
          type: 'question',
          payload: pending.payload,
          mode: pending.mode,
          sourceLabel: pending.sourceLabel,
          question
        });
        await bot.sendMessage(chatId, question.prompt);
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
          '2': { kind: 'customer.receiver', prompt: 'Anh muốn sửa người nhận thành gì?' },
          '3': { kind: 'customer.department', prompt: 'Anh muốn sửa bộ phận thành gì?' },
          '4': { kind: 'customer.phone', prompt: 'Anh muốn sửa số điện thoại thành gì?' },
          '5': { kind: 'customer.email', prompt: 'Anh muốn sửa email thành gì?' },
          '7': { kind: 'profitRate', prompt: 'Anh muốn sửa lãi suất thành bao nhiêu (%)?' },
          '8': { kind: 'vatPercent', prompt: 'Anh muốn sửa VAT thành bao nhiêu (%)?' },
          '9': { kind: 'meta.signerChoice', prompt: 'Anh muốn đổi người ký nào? Nhập 1, 2 hoặc 3 giúp em nhé.' },
          '10': { kind: 'meta.paymentDaysText', prompt: 'Anh gửi giúp em điều khoản / nội dung chính mới để em cập nhật lại preview nhé.' },
          '11': { kind: 'meta.warrantyMonthsText', prompt: 'Anh muốn sửa thời gian bảo hành thành gì?' },
          '12': { kind: 'meta.quoteValidityDaysText', prompt: 'Anh muốn sửa hiệu lực báo giá thành gì?' }
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

        if (trimmed === '6') {
          await sendItemEditList({ bot, setPending, chatId, payload: pending.payload, mode: pending.mode, sourceLabel: pending.sourceLabel, action: 'edit' });
          return;
        }

        if (trimmed === '2' || trimmed === '3' || trimmed === '4' || trimmed === '5') {
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

        if (applyQuickPreviewEdit(pending.payload, text)) {
          setPending(chatId, pending);
          await bot.sendMessage(chatId, buildPreviewMessage(pending.payload));
          return;
        }

        await bot.sendMessage(chatId, 'Anh nhắn ok để xuất, hoặc nhắn một số như 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12 để sửa nhanh trên preview nhé.');
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
        case 'customer.receiver':
          pending.payload.customer.receiver = String(answer || '');
          break;
        case 'customer.department':
          pending.payload.customer.department = String(answer || '');
          break;
        case 'customer.phone':
          pending.payload.customer.phone = String(answer || '');
          break;
        case 'customer.email':
          pending.payload.customer.email = String(answer || '');
          break;
        case 'item.description':
          if (pending.payload.items[pending.question.index]) pending.payload.items[pending.question.index].description = String(answer || '');
          break;
        case 'item.origin':
          if (pending.payload.items[pending.question.index]) pending.payload.items[pending.question.index].origin = String(answer || '');
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
        case 'item.add.description': {
          pending.payload.items = Array.isArray(pending.payload.items) ? pending.payload.items : [];
          pending.payload.items.push({
            description: String(answer || ''),
            origin: '',
            unit: '',
            quantity: 0,
            costPrice: 0,
            productContent: ''
          });
          setPending(chatId, {
            type: 'question',
            payload: pending.payload,
            mode: pending.mode,
            sourceLabel: pending.sourceLabel,
            question: {
              kind: 'item.add.origin',
              index: pending.payload.items.length - 1,
              prompt: 'Anh cho em xuất xứ của mặt hàng mới nhé?'
            }
          });
          await bot.sendMessage(chatId, 'Anh cho em xuất xứ của mặt hàng mới nhé?');
          return;
        }
        case 'item.add.origin':
          if (pending.payload.items[pending.question.index]) pending.payload.items[pending.question.index].origin = String(answer || '');
          setPending(chatId, {
            type: 'question',
            payload: pending.payload,
            mode: pending.mode,
            sourceLabel: pending.sourceLabel,
            question: {
              kind: 'item.add.unit',
              index: pending.question.index,
              prompt: 'Anh cho em đơn vị tính của mặt hàng mới nhé?'
            }
          });
          await bot.sendMessage(chatId, 'Anh cho em đơn vị tính của mặt hàng mới nhé?');
          return;
        case 'item.add.unit':
          if (pending.payload.items[pending.question.index]) pending.payload.items[pending.question.index].unit = String(answer || '');
          setPending(chatId, {
            type: 'question',
            payload: pending.payload,
            mode: pending.mode,
            sourceLabel: pending.sourceLabel,
            question: {
              kind: 'item.add.quantity',
              index: pending.question.index,
              prompt: 'Anh cho em số lượng của mặt hàng mới nhé?'
            }
          });
          await bot.sendMessage(chatId, 'Anh cho em số lượng của mặt hàng mới nhé?');
          return;
        case 'item.add.quantity':
          if (pending.payload.items[pending.question.index]) pending.payload.items[pending.question.index].quantity = Number(answer || 0);
          setPending(chatId, {
            type: 'question',
            payload: pending.payload,
            mode: pending.mode,
            sourceLabel: pending.sourceLabel,
            question: {
              kind: 'item.add.costPrice',
              index: pending.question.index,
              prompt: 'Anh cho em giá đầu vào của mặt hàng mới nhé?'
            }
          });
          await bot.sendMessage(chatId, 'Anh cho em giá đầu vào của mặt hàng mới nhé?');
          return;
        case 'item.add.costPrice':
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
      if (!isAdminUser(msg.from?.id) && String(directQuoteLookup.createdBy || '') !== String(msg.from?.id || '')) {
        await bot.sendMessage(chatId, 'Anh chỉ có quyền xem các báo giá do chính mình tạo.', buildMainMenuForUser(chatId));
        return;
      }
      setPending(chatId, { type: 'quote-view', quoteNumber: directQuoteLookup.quoteNumber });
      await bot.sendMessage(chatId, formatQuoteSummary(directQuoteLookup), buildQuoteActionMenu(directQuoteLookup.quoteNumber));
      return;
    }

    if (text === '🔎 Tìm báo giá') {
      if (!ensureAdmin(chatId, msg.from?.id)) return;
      setPending(chatId, { type: 'search-quote' });
      await bot.sendMessage(chatId, 'Anh nhập số BG hoặc tên khách hàng để em tìm nhé.', buildMainMenuForUser(chatId));
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

    const parseStartedAt = Date.now();
    const { payload, mode } = await routeInput({ text, imageBuffer, mimeType: 'image/jpeg' }, {
      defaultProfitRate: config.defaultProfitRate,
      defaultVatPercent: config.defaultVatPercent
    });

    log.info('Phân tích đầu vào thành công', {
      chatId,
      userId: String(msg?.from?.id || ''),
      mode,
      durationMs: Date.now() - parseStartedAt,
      customerName: payload?.customer?.name || '',
      itemCount: Array.isArray(payload?.items) ? payload.items.length : 0
    });

    attachTelegramUserMeta(payload, msg);

    if (imagePath && fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
    if (processedImagePath && fs.existsSync(processedImagePath)) fs.unlinkSync(processedImagePath);

    await continueWithPayload(chatId, payload, mode, imageBuffer ? 'ảnh' : 'text');
  } catch (err) {
    log.error('Lỗi bot Telegram', {
      chatId,
      userId: String(msg?.from?.id || ''),
      error: err.message,
      stack: err?.stack || ''
    });
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
