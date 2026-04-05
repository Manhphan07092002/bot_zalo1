const { config } = require('./config');

function shortenItemLabel(text, maxLength = 40) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Chưa rõ tên sản phẩm';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trim()}…`;
}

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

function buildMainMenu(isAdmin) {
  return {
    reply_markup: {
      keyboard: isAdmin
        ? [
            ['📝 Tạo báo giá mới', '📂 Báo giá gần đây'],
            ['📁 Báo giá của tôi', '🔎 Tìm báo giá'],
            ['❓ Hướng dẫn']
          ]
        : [
            ['📝 Tạo báo giá mới', '📁 Báo giá của tôi'],
            ['❓ Hướng dẫn']
          ],
      resize_keyboard: true,
      persistent: true,
      is_persistent: true,
      one_time_keyboard: false
    }
  };
}

function formatQuoteList(entries, title) {
  if (!entries.length) return `${title}\n\nChưa có dữ liệu.`;
  return [
    title,
    '',
    ...entries.map((entry, index) => {
      const when = String(entry.createdAt || '').replace('T', ' ').slice(0, 16);
      const owner = entry.createdByName || entry.createdByUsername ? ` | ${entry.createdByName || entry.createdByUsername}` : '';
      return `${index + 1}. BG ${entry.quoteNumber} | ${entry.customerName || 'Chưa rõ'} | ${entry.total || '0'} | ${when}${owner}`;
    })
  ].join('\n');
}

function buildQuotePickKeyboard(entries, pager = {}) {
  const { page = 0, pageSize = config.quoteListLimit, total = entries.length, mode = 'recent', keyword = '' } = pager;
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const navRow = [];
  if (page > 0) navRow.push({ text: '⬅️ Trước', callback_data: `quote:list:${mode}:${page - 1}:${encodeURIComponent(keyword || '')}` });
  if (page < totalPages - 1) navRow.push({ text: '➡️ Sau', callback_data: `quote:list:${mode}:${page + 1}:${encodeURIComponent(keyword || '')}` });

  return {
    inline_keyboard: [
      ...entries.map((entry) => {
        const quoteNumber = String(entry.quoteNumber || '').padStart(3, '0');
        const customerName = shortenItemLabel(entry.customerName || 'Chưa rõ', 22);
        const totalText = String(entry.total || '0');
        const when = String(entry.createdAt || '').replace('T', ' ').slice(0, 16);
        return [{
          text: `BG ${quoteNumber} • ${customerName} • ${totalText} • ${when}`,
          callback_data: `quote:open:${quoteNumber}`
        }];
      }),
      ...(navRow.length ? [navRow] : []),
      [{ text: '⬅️ Quay lại menu chính', callback_data: 'quote:back' }]
    ]
  };
}

function formatQuotePickerIntro(totalEntries, title, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil(totalEntries / Math.max(1, pageSize)));
  return totalEntries
    ? `${title} (trang ${page + 1}/${totalPages})\n\nAnh chọn báo giá bằng nút bên dưới nhé.`
    : `${title}\n\nChưa có dữ liệu.`;
}

function formatQuoteSummary(entry) {
  if (!entry) return 'Không tìm thấy báo giá.';
  const when = String(entry.createdAt || '').replace('T', ' ').slice(0, 16);
  const isLegacy = entry?.legacy === true || entry?.sourceMissing === true;
  return [
    `Thông tin báo giá BG ${String(entry.quoteNumber || '').padStart(3, '0')}:`,
    '',
    `• Khách hàng: ${entry.customerName || 'Chưa rõ'}`,
    `• Người nhận: ${entry.customerReceiver || 'Chưa rõ'}`,
    `• Số mặt hàng: ${entry.itemCount || 0}`,
    `• Tổng tiền: ${entry.total || '0'}`,
    `• Thời gian tạo: ${when}`,
    ...(isLegacy
      ? [
          '',
          '⚠️ Đây là báo giá legacy / thiếu source dữ liệu gốc.',
          'Một số chức năng như sửa sâu hoặc khôi phục đầy đủ có thể không dùng được.'
        ]
      : []),
    '',
    'Anh chọn thao tác ở menu bên dưới để tiếp tục.'
  ].join('\n');
}

function formatEditableItemLine(item, index) {
  return [
    `${index + 1}. ${item?.description || 'Chưa rõ tên'}`,
    `   • Xuất xứ: ${item?.origin || 'Chưa rõ'}`,
    `   • Đơn vị: ${item?.unit || 'Chưa rõ'}`,
    `   • Số lượng: ${Number(item?.quantity || 0).toLocaleString('vi-VN')}`,
    `   • Giá đầu vào: ${Number(item?.costPrice || 0).toLocaleString('vi-VN')}`
  ].join('\n');
}

function buildPreviewInlineKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '✅ Xuất PDF', callback_data: 'preview:ok' }
      ],
      [
        { text: '➕ Thêm sản phẩm', callback_data: 'item:add' },
        { text: '✏️ Sửa sản phẩm', callback_data: 'item:edit:list' }
      ],
      [
        { text: '❌ Xóa sản phẩm', callback_data: 'item:delete:list' }
      ]
    ]
  };
}

module.exports = {
  shortenItemLabel,
  buildQuoteActionMenu,
  buildMainMenu,
  formatQuoteList,
  buildQuotePickKeyboard,
  formatQuotePickerIntro,
  formatQuoteSummary,
  formatEditableItemLine,
  buildPreviewInlineKeyboard
};
