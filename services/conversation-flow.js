const { setPending, getPending, clearPending } = require('./pending-store');

function shouldCancelFlow(text) {
  const normalized = String(text || '').trim().toLowerCase();
  return ['không', 'khong', 'exit', 'thoát', 'thoat', 'dừng', 'dung', 'hủy', 'huy', 'cancel'].includes(normalized);
}

function getNextQuestion(payload) {
  payload.customer = payload.customer || {};
  payload.items = Array.isArray(payload.items) ? payload.items : [];
  payload.meta = payload.meta || {};

  if (!payload.customer.name) {
    return { kind: 'customer.name', prompt: 'Em chưa thấy rõ tên đơn vị / khách hàng. Anh muốn em in báo giá cho đơn vị nào để em làm tiếp nhé?' };
  }

  for (let i = 0; i < payload.items.length; i += 1) {
    const item = payload.items[i] || {};
    const label = item.description || `mặt hàng ${i + 1}`;
    if (!item.unit) return { kind: 'item.unit', index: i, prompt: `Mặt hàng "${label}" đang thiếu đơn vị tính. Anh cho em đơn vị tính để em làm tiếp nhé?` };
    if (!(Number(item.quantity) > 0)) return { kind: 'item.quantity', index: i, prompt: `Mặt hàng "${label}" đang thiếu số lượng. Anh cho em số lượng để em làm tiếp nhé?` };
    if (!(Number(item.costPrice) > 0)) return { kind: 'item.costPrice', index: i, prompt: `Mặt hàng "${label}" đang thiếu giá nhập. Anh cho em giá nhập để em làm tiếp nhé?` };
  }

  if (!(Number(payload.profitRate) > 0)) {
    return { kind: 'profitRate', prompt: 'Em chưa thấy rõ lãi suất. Anh cho em lãi suất (%) để em làm tiếp nhé?' };
  }

  if (!(Number(payload.vatPercent) >= 0)) {
    payload.vatPercent = 8;
  }

  if (payload.meta.askTerms === undefined) payload.meta.askTerms = true;
  payload.meta.askTerms = payload.meta.askTerms === true;

  const termKeys = [
    ['deliveryDaysText', 'Em chưa thấy rõ thời gian giao hàng. Anh cho em thông tin giao hàng để em làm tiếp nhé?'],
    ['paymentDaysText', 'Em chưa thấy rõ thời hạn thanh toán. Anh cho em thông tin thanh toán để em làm tiếp nhé?'],
    ['warrantyMonthsText', 'Em chưa thấy rõ thời gian bảo hành. Anh cho em thời gian bảo hành để em làm tiếp nhé?'],
    ['quoteValidityDaysText', 'Em chưa thấy rõ hiệu lực báo giá. Anh cho em thời hạn hiệu lực để em làm tiếp nhé?']
  ];

  if (payload.meta.askTerms) {
    for (const [key, prompt] of termKeys) {
      if (!String(payload.meta[key] || '').trim()) return { kind: `meta.${key}`, prompt };
    }
    payload.meta.askTerms = false;
  }

  if (!payload.meta.deliveryDaysText) payload.meta.deliveryDaysText = '7-10 ngày';
  if (!payload.meta.paymentDaysText) payload.meta.paymentDaysText = '30 ngày';
  if (!payload.meta.warrantyMonthsText) payload.meta.warrantyMonthsText = '12 tháng';
  if (!payload.meta.quoteValidityDaysText) payload.meta.quoteValidityDaysText = '30 ngày';

  if (!String(payload.meta.signerChoice || '').trim()) {
    return {
      kind: 'meta.signerChoice',
      prompt: 'Em chưa thấy rõ người ký báo giá. Anh chọn giúp em một trong 3 phương án sau để em làm tiếp nhé:\n1. TỔNG GIÁM ĐỐC: NGUYỄN VĂN DUY\n2. PHÓ TỔNG GIÁM ĐỐC: DƯƠNG THÁI XUYÊN\n3. GIÁM ĐỐC KINH DOANH: NGUYỄN VĂN ĐẠT'
    };
  }

  return null;
}

function parseAnswerValue(kind, text) {
  const trimmed = String(text || '').trim();
  if ((kind && kind.startsWith('customer.')) || kind === 'item.unit' || kind === 'item.description') return trimmed;
  if (kind && kind.startsWith('meta.')) return trimmed;
  const num = Number(trimmed.replace(/[^\d.-]/g, ''));
  return Number.isFinite(num) ? num : trimmed;
}

function validatePendingAnswer(question, text) {
  const trimmed = String(text || '').trim();
  switch (question?.kind) {
    case 'customer.name': return trimmed ? null : 'Tên khách hàng chưa hợp lệ. Anh nhập lại giúp em nhé.';
    case 'customer.receiver': return trimmed ? null : 'Người nhận chưa hợp lệ. Anh nhập lại giúp em nhé.';
    case 'customer.department': return trimmed ? null : 'Bộ phận chưa hợp lệ. Anh nhập lại giúp em nhé.';
    case 'customer.phone': return trimmed ? null : 'Số điện thoại chưa hợp lệ. Anh nhập lại giúp em nhé.';
    case 'customer.email': return trimmed ? null : 'Email chưa hợp lệ. Anh nhập lại giúp em nhé.';
    case 'item.description':
    case 'item.origin':
    case 'item.add.description':
    case 'item.add.origin':
    case 'item.add.unit':
      return trimmed ? null : 'Thông tin mặt hàng chưa hợp lệ. Anh nhập lại giúp em nhé.';
    case 'item.unit': return trimmed ? null : 'Đơn vị tính chưa hợp lệ. Anh nhập lại giúp em nhé.';
    case 'item.quantity':
    case 'item.add.quantity':
      return Number(trimmed.replace(/[^\d.-]/g, '')) > 0 ? null : 'Số lượng chưa hợp lệ. Anh nhập lại giúp em bằng số nhé.';
    case 'item.costPrice':
    case 'item.add.costPrice':
      return Number(trimmed.replace(/[^\d.-]/g, '')) > 0 ? null : 'Giá nhập chưa hợp lệ. Anh nhập lại giúp em bằng số nhé.';
    case 'profitRate': return Number(trimmed.replace(/[^\d.-]/g, '')) > 0 ? null : 'Lãi suất chưa hợp lệ. Anh nhập lại giúp em bằng số phần trăm nhé.';
    case 'vatPercent': return Number(trimmed.replace(/[^\d.-]/g, '')) >= 0 ? null : 'Thuế VAT chưa hợp lệ. Anh nhập lại giúp em bằng số phần trăm nhé.';
    case 'meta.signerChoice':
      return /^(1|2|3)$/.test(trimmed) || /duy|xuyên|xuyen|đạt|dat/i.test(trimmed) ? null : 'Lựa chọn người ký chưa hợp lệ. Anh chọn 1, 2 hoặc 3 giúp em nhé.';
    case 'meta.deliveryDaysText':
    case 'meta.paymentDaysText':
    case 'meta.warrantyMonthsText':
    case 'meta.quoteValidityDaysText':
      return /\d/.test(trimmed) || trimmed.length > 30 ? null : 'Thông tin này chưa hợp lệ. Anh nhập lại giúp em theo dạng như 7 ngày, 7-10 ngày hoặc 12 tháng nhé.';
    default:
      return null;
  }
}

function normalizePayloadBeforeQuestions(payload) {
  payload.customer = payload.customer || {};
  payload.items = Array.isArray(payload.items)
    ? payload.items.map((item) => ({
        description: item?.description || item?.productTitle || '',
        origin: item?.origin || '',
        unit: item?.unit || '',
        quantity: Number(item?.quantity || 0),
        costPrice: Number((item?.costPrice ?? item?.unitPrice) || 0),
        productContent: item?.productContent || ''
      }))
    : [];
  payload.meta = payload.meta || {};
  return payload;
}

function resolveSignerInfo(choice) {
  const signerMap = {
    '1': { title: 'TỔNG GIÁM ĐỐC', name: 'NGUYỄN VĂN DUY' },
    '2': { title: 'PHÓ TỔNG GIÁM ĐỐC', name: 'DƯƠNG THÁI XUYÊN' },
    '3': { title: 'GIÁM ĐỐC KINH DOANH', name: 'NGUYỄN VĂN ĐẠT' }
  };
  return signerMap[String(choice || '3')] || signerMap['3'];
}

function buildPreviewMessage(payload) {
  const customerName = payload?.customer?.name || 'Chưa rõ';
  const itemCount = Array.isArray(payload?.items) ? payload.items.length : 0;
  const profitRate = Number(payload?.profitRate || 0);
  const vatPercent = Number(payload?.vatPercent || 0);
  const meta = payload?.meta || {};
  const signer = resolveSignerInfo(meta.signerChoice);
  const deliveryClause = String(meta.deliveryPaymentClause || '').trim();
  const terms = deliveryClause || `Giao hàng: ${meta.deliveryDaysText || '7-10 ngày'} | Thanh toán: ${meta.paymentDaysText || '30 ngày'}`;

  return [
    'Em gửi Anh bản xem trước trước khi xuất PDF:',
    '',
    `1. Khách hàng: ${customerName}`,
    `2. Người nhận: ${payload?.customer?.receiver || 'Chưa rõ'}`,
    `3. Bộ phận: ${payload?.customer?.department || 'Chưa rõ'}`,
    `4. Điện thoại: ${payload?.customer?.phone || 'Chưa rõ'}`,
    `5. Email: ${payload?.customer?.email || 'Chưa rõ'}`,
    `6. Số mặt hàng: ${itemCount}`,
    `7. Lãi suất: ${profitRate}%`,
    `8. VAT: ${vatPercent}%`,
    `9. Người ký: ${signer.title} - ${signer.name}`,
    `10. Điều khoản chính: ${terms}`,
    `11. Bảo hành: ${meta.warrantyMonthsText || '12 tháng'}`,
    `12. Hiệu lực báo giá: ${meta.quoteValidityDaysText || '30 ngày'}`,
    '',
    'Nếu đúng rồi, Anh trả lời: ok',
    'Nếu cần sửa, Anh chỉ cần nhắn số thứ tự (ví dụ: 7).'
  ].join('\n');
}

module.exports = {
  shouldCancelFlow,
  getNextQuestion,
  parseAnswerValue,
  validatePendingAnswer,
  normalizePayloadBeforeQuestions,
  resolveSignerInfo,
  buildPreviewMessage,
  setPending,
  getPending,
  clearPending
};
