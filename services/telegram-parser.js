const FIELD_ALIASES = {
  customerName: ['khách hàng', 'khach hang'],
  customerReceiver: ['người nhận', 'nguoi nhan'],
  customerDepartment: ['bộ phận', 'bo phan'],
  phone: ['điện thoại', 'dien thoai', 'số điện thoại', 'so dien thoai'],
  email: ['email', 'e-mail'],
  profitRate: ['lãi suất', 'lai suat', 'lợi nhuận', 'loi nhuan'],
  vatPercent: ['vat', 'thuế vat', 'thue vat']
};

function normalizeKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function parseFlexibleNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const normalized = String(value)
    .replace(/\s+/g, '')
    .replace(/,/g, '')
    .replace(/\.(?=\d{3}(\D|$))/g, '')
    .replace(/[^\d.-]/g, '');

  const n = Number(normalized);
  return Number.isFinite(n) ? n : fallback;
}

function findField(lines, aliases) {
  const aliasSet = new Set(aliases.map(normalizeKey));

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const idx = line.indexOf(':');
    if (idx === -1) continue;

    const key = normalizeKey(line.slice(0, idx));
    const value = line.slice(idx + 1).trim();

    if (aliasSet.has(key)) {
      return value;
    }
  }

  return '';
}

function parseItems(lines) {
  const items = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const cleaned = line.replace(/^[-*]\s*/, '').replace(/^\d+[.)]\s*/, '');
    const parts = cleaned.split('|').map((s) => s.trim());

    if (parts.length < 5) continue;

    const quantity = parseFlexibleNumber(parts[3], 0);
    const costPrice = parseFlexibleNumber(parts[4], 0);

    items.push({
      description: parts[0] || '',
      origin: parts[1] || '',
      unit: parts[2] || '',
      quantity,
      costPrice,
      productContent: parts.slice(5).join(' | ')
    });
  }

  return items;
}

function parseQuoteRequest(text, defaults = {}) {
  const lines = String(text || '').split(/\r?\n/);

  const customerName = findField(lines, FIELD_ALIASES.customerName);
  const customerReceiver = findField(lines, FIELD_ALIASES.customerReceiver);
  const customerDepartment = findField(lines, FIELD_ALIASES.customerDepartment);
  const phone = findField(lines, FIELD_ALIASES.phone);
  const email = findField(lines, FIELD_ALIASES.email);
  const profitRateRaw = findField(lines, FIELD_ALIASES.profitRate);
  const vatPercentRaw = findField(lines, FIELD_ALIASES.vatPercent);

  const goodsIndex = lines.findIndex((line) => /^\s*(hang hoa|hàng hóa)\s*:/i.test(line));
  const itemLines = goodsIndex === -1 ? [] : lines.slice(goodsIndex + 1);
  const items = parseItems(itemLines);

  return {
    customer: {
      name: customerName || '',
      receiver: customerReceiver || '',
      department: customerDepartment || '',
      phone: phone || '',
      email: email || ''
    },
    items,
    profitRate: parseFlexibleNumber(profitRateRaw, defaults.defaultProfitRate ?? 12),
    vatPercent: parseFlexibleNumber(vatPercentRaw, defaults.defaultVatPercent ?? 8)
  };
}

function validatePayload(payload) {
  if (!payload.customer?.name) {
    return 'Thiếu tên khách hàng.';
  }

  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return 'Thiếu danh sách hàng hóa. Mỗi dòng cần theo mẫu: Tên | Xuất xứ | ĐVT | SL | Giá nhập';
  }

  for (const item of payload.items) {
    if (!item.description) return 'Có mặt hàng thiếu mô tả.';
    if (!(item.quantity > 0)) return `Mặt hàng "${item.description}" thiếu hoặc sai số lượng.`;
    if (!(item.costPrice > 0)) return `Mặt hàng "${item.description}" thiếu hoặc sai giá nhập.`;
  }

  return null;
}

module.exports = {
  parseQuoteRequest,
  validatePayload,
  parseFlexibleNumber
};
