async function handleItemCallbacks(ctx) {
  const {
    data, pending, query, chatId, bot, setPending,
    buildAddItemQuestion, sendItemEditList, buildItemEditFieldState,
    buildItemEditFieldPrompt, continueWithPayload
  } = ctx;

  if (data === 'item:back:preview' && pending?.payload) {
    await bot.answerCallbackQuery(query.id, { text: 'Đã quay lại preview' });
    await continueWithPayload(chatId, pending.payload, pending.mode || 'preview-return', pending.sourceLabel || 'text');
    return true;
  }

  if (data === 'item:add' && pending?.payload) {
    await bot.answerCallbackQuery(query.id, { text: 'Thêm sản phẩm mới' });
    setPending(chatId, buildAddItemQuestion(pending.payload, pending));
    await bot.sendMessage(chatId, 'Anh gửi giúp em tên sản phẩm mới để em thêm dòng nhé.');
    return true;
  }

  if (data === 'item:edit:list' && pending?.payload) {
    await bot.answerCallbackQuery(query.id, { text: 'Chọn dòng cần sửa' });
    await sendItemEditList({ bot, setPending, chatId, payload: pending.payload, mode: pending.mode, sourceLabel: pending.sourceLabel, action: 'edit' });
    return true;
  }

  if (data === 'item:delete:list' && pending?.payload) {
    await bot.answerCallbackQuery(query.id, { text: 'Chọn dòng cần xóa' });
    await sendItemEditList({ bot, setPending, chatId, payload: pending.payload, mode: pending.mode, sourceLabel: pending.sourceLabel, action: 'delete' });
    return true;
  }

  const itemEditMatch = data.match(/^item:edit:(\d+)$/);
  if (itemEditMatch && pending?.payload) {
    const itemIndex = Number(itemEditMatch[1]);
    if (!pending.payload?.items?.[itemIndex]) {
      await bot.answerCallbackQuery(query.id, { text: 'Không thấy dòng cần sửa', show_alert: false });
      return true;
    }
    await bot.answerCallbackQuery(query.id, { text: `Đang sửa dòng ${itemIndex + 1}` });
    setPending(chatId, buildItemEditFieldState(pending.payload, pending, itemIndex));
    await bot.sendMessage(chatId, buildItemEditFieldPrompt(pending.payload, itemIndex));
    return true;
  }

  const itemDeleteMatch = data.match(/^item:delete:(\d+)$/);
  if (itemDeleteMatch && pending?.payload) {
    const itemIndex = Number(itemDeleteMatch[1]);
    if (!pending.payload?.items?.[itemIndex]) {
      await bot.answerCallbackQuery(query.id, { text: 'Không thấy dòng cần xóa', show_alert: false });
      return true;
    }
    const removed = pending.payload.items.splice(itemIndex, 1)[0];
    await bot.answerCallbackQuery(query.id, { text: `Đã xóa dòng ${itemIndex + 1}` });
    await bot.sendMessage(chatId, `Em đã xóa dòng ${itemIndex + 1}: ${removed?.description || 'Chưa rõ tên sản phẩm'}.`);
    await continueWithPayload(chatId, pending.payload, pending.mode || 'item-delete', pending.sourceLabel || 'text');
    return true;
  }

  return false;
}

async function handleQuoteListCallbacks(ctx) {
  const {
    data, query, chatId, userId,
    ensureAdmin, buildQuoteListView, isAdminUser,
    getRecentQuotes, getQuotesByUser, findQuotesByKeyword,
    sendQuotePicker
  } = ctx;

  const quoteListMatch = data.match(/^quote:list:(recent|mine|search):(\d+):(.*)$/);
  if (!quoteListMatch) return false;

  const [, listMode, pageRaw, keywordEncoded] = quoteListMatch;
  const page = Number(pageRaw || 0);
  const keyword = decodeURIComponent(keywordEncoded || '');
  if (listMode === 'recent' && !ensureAdmin(chatId, userId)) {
    await ctx.bot.answerCallbackQuery(query.id, { text: 'Chức năng này chỉ dành cho admin', show_alert: false });
    return true;
  }

  const { entries, title } = buildQuoteListView({
    mode: listMode,
    userId,
    keyword,
    isAdminUser,
    getRecentQuotes,
    getQuotesByUser,
    findQuotesByKeyword
  });

  await ctx.bot.answerCallbackQuery(query.id, { text: `Trang ${page + 1}` });
  await sendQuotePicker(chatId, entries, title, userId, { page, mode: listMode, keyword });
  return true;
}

async function handleQuoteActionCallbacks(ctx) {
  const {
    data, query, chatId, userId, bot, setPending, clearPending,
    findQuoteByNumber, ensureQuoteAccess, formatQuoteSummary,
    buildQuoteActionMenu, findPdfPathByQuoteNumber, getQuoteSource,
    buildEditablePayloadFromSource, continueWithPayload, sendMainMenu
  } = ctx;

  if (data === 'quote:back') {
    clearPending(chatId);
    await bot.answerCallbackQuery(query.id, { text: 'Đã quay lại menu chính' });
    await sendMainMenu(chatId, 'Đã quay lại menu chính.');
    return true;
  }

  const quoteOpenMatch = data.match(/^quote:open:(\d{3})$/);
  if (quoteOpenMatch) {
    const quoteNumber = quoteOpenMatch[1];
    const entry = findQuoteByNumber(quoteNumber);
    if (!(await ensureQuoteAccess(chatId, userId, entry))) {
      await bot.answerCallbackQuery(query.id, { text: 'Không có quyền truy cập', show_alert: false });
      return true;
    }
    setPending(chatId, { type: 'quote-view', quoteNumber });
    await bot.answerCallbackQuery(query.id, { text: `Đang mở BG ${quoteNumber}` });
    await bot.sendMessage(chatId, formatQuoteSummary(entry), buildQuoteActionMenu(quoteNumber));
    return true;
  }

  const quoteMatch = data.match(/^quote:(edit|review|pdf):(\d{3})$/);
  if (!quoteMatch) return false;

  const [, action, quoteNumber] = quoteMatch;
  setPending(chatId, { type: 'quote-view', quoteNumber });

  const entry = findQuoteByNumber(quoteNumber);
  if (!(await ensureQuoteAccess(chatId, userId, entry))) {
    await bot.answerCallbackQuery(query.id, { text: 'Không có quyền truy cập', show_alert: false });
    return true;
  }

  if (action === 'review') {
    await bot.answerCallbackQuery(query.id, { text: `Đang mở BG ${quoteNumber}` });
    await bot.sendMessage(chatId, formatQuoteSummary(entry), buildQuoteActionMenu(quoteNumber));
    return true;
  }

  if (action === 'pdf') {
    const pdfPath = findPdfPathByQuoteNumber(quoteNumber);
    if (!pdfPath) {
      await bot.answerCallbackQuery(query.id, { text: 'Chưa tìm thấy PDF', show_alert: false });
      await bot.sendMessage(chatId, 'Em chưa tìm thấy file PDF của báo giá này.', buildQuoteActionMenu(quoteNumber));
      return true;
    }
    await bot.answerCallbackQuery(query.id, { text: `Đang gửi PDF BG ${quoteNumber}` });
    await bot.sendDocument(chatId, pdfPath, { caption: `Em gửi lại PDF của BG ${quoteNumber}.` }, { filename: require('path').basename(pdfPath), contentType: 'application/pdf' });
    return true;
  }

  if (action === 'edit') {
    const source = getQuoteSource(quoteNumber);
    if (!source) {
      await bot.answerCallbackQuery(query.id, { text: 'Chưa có dữ liệu gốc để sửa', show_alert: false });
      await bot.sendMessage(chatId, 'Em chưa tìm thấy dữ liệu gốc để sửa báo giá này. Các báo giá tạo từ bây giờ sẽ hỗ trợ sửa đầy đủ hơn.', buildQuoteActionMenu(quoteNumber));
      return true;
    }
    await bot.answerCallbackQuery(query.id, { text: `Đang mở sửa BG ${quoteNumber}` });
    clearPending(chatId);
    await continueWithPayload(chatId, buildEditablePayloadFromSource(source, quoteNumber), 'edit-existing-quote', 'text');
    return true;
  }

  return false;
}

module.exports = {
  handleItemCallbacks,
  handleQuoteListCallbacks,
  handleQuoteActionCallbacks
};
