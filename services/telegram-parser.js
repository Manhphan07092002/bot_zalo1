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
    if (idx !== -1) {
      const key = normalizeKey(line.slice(0, idx));
      const value = line.slice(idx + 1).trim();

      if (aliasSet.has(key)) {
        return value;
      }
    }

    const commaSegments = line.split(',').map((s) => s.trim()).filter(Boolean);
    for (const segment of commaSegments) {
      const lower = normalizeKey(segment);
      for (const alias of aliasSet) {
        if (lower.startsWith(alias + ' ')) {
          return segment.slice(alias.length).trim();
        }
      }
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

    if (parts.length >= 5) {
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
      continue;
    }

    const naturalMatch = cleaned.match(/^(.*?)(?:,\s*xuất xứ\s*(.+?))?(?:,\s*đơn vị\s*(.+?))?(?:,\s*số lượng\s*(\d+[\d\.,]*))?(?:,\s*giá nhập\s*([\d\.,]+))$/i);
    if (naturalMatch) {
      items.push({
        description: (naturalMatch[1] || '').trim(),
        origin: (naturalMatch[2] || '').trim(),
        unit: (naturalMatch[3] || '').trim(),
        quantity: parseFlexibleNumber(naturalMatch[4], 0),
        costPrice: parseFlexibleNumber(naturalMatch[5], 0),
        productContent: ''
      });
    }
  }

  return items;
}

function inferCustomerNameFromFreeText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const patterns = [
    /(?:tạo|lam|làm|gửi|gui)?\s*báo\s*giá\s*cho\s+([^\.\n,]+)/i,
    /(?:tạo|lam|làm)?\s*bảng?\s*chào\s*giá\s*cho\s+([^\.\n,]+)/i,
    /kính\s*gửi\s+([^\.\n,]+)/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return match[1].trim();
  }

  return '';
}

function findGlobalExplicitRate(text, patterns) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return match[1];
  }
  return '';
}

function parseQuoteRequest(text, defaults = {}) {
  const lines = String(text || '').split(/\r?\n/);

  const customerName = findField(lines, FIELD_ALIASES.customerName) || inferCustomerNameFromFreeText(text);
  const customerReceiver = findField(lines, FIELD_ALIASES.customerReceiver);
  const customerDepartment = findField(lines, FIELD_ALIASES.customerDepartment);
  const phone = findField(lines, FIELD_ALIASES.phone);
  const email = findField(lines, FIELD_ALIASES.email);
  const profitRateRaw = findField(lines, FIELD_ALIASES.profitRate) || findGlobalExplicitRate(text, [/(?:lãi suất|lãi)\s*[:=]?\s*(\d+(?:[\.,]\d+)?)/i]);
  const vatPercentRaw = findField(lines, FIELD_ALIASES.vatPercent) || findGlobalExplicitRate(text, [/(?:thuế\s*vat|vat)\s*[:=]?\s*(\d+(?:[\.,]\d+)?)/i]);

  const goodsIndex = lines.findIndex((line) => /^\s*(hang hoa|hàng hóa|danh sách hàng)\s*:/i.test(line));
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
