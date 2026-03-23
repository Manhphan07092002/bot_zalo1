const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function formatMoney(value) {
  return Number(value || 0).toLocaleString('vi-VN');
}

function numberToVietnamese(n) {
  n = Math.round(Number(n || 0));
  if (n === 0) return 'Không đồng chẵn.';

  const digits = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
  const units = ['', ' nghìn', ' triệu', ' tỷ', ' nghìn tỷ', ' triệu tỷ'];

  function readTriple(num, full) {
    const hundred = Math.floor(num / 100);
    const ten = Math.floor((num % 100) / 10);
    const one = num % 10;
    let out = '';

    if (full || hundred > 0) {
      out += `${digits[hundred]} trăm`;
      if (ten === 0 && one > 0) out += ' lẻ';
    }

    if (ten > 1) {
      out += ` ${digits[ten]} mươi`;
      if (one === 1) out += ' mốt';
      else if (one === 5) out += ' lăm';
      else if (one > 0) out += ` ${digits[one]}`;
    } else if (ten === 1) {
      out += ' mười';
      if (one === 5) out += ' lăm';
      else if (one > 0) out += ` ${digits[one]}`;
    } else if (ten === 0 && one > 0) {
      out += ` ${one === 5 && !full ? 'năm' : digits[one]}`;
    }

    return out.trim();
  }

  const chunks = [];
  let num = Math.floor(n);
  while (num > 0) {
    chunks.push(num % 1000);
    num = Math.floor(num / 1000);
  }

  const parts = [];
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i];
    if (chunk === 0) continue;
    const full = i < chunks.length - 1;
    parts.push(`${readTriple(chunk, full)}${units[i]}`.trim());
  }

  const sentence = parts.join(' ').replace(/\s+/g, ' ').trim();
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + ' đồng chẵn.';
}

function normalizeNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  const cleaned = String(value).replace(/[^\d.-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : fallback;
}

function getCounterPath() {
  return path.resolve(__dirname, '..', 'data', 'counter.json');
}

function getNextQuoteNumber(productsInput) {
  const counterPath = getCounterPath();
  let currentId = 0;
  let lastHash = '';

  if (fs.existsSync(counterPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
      currentId = data.currentId ?? 0;
      lastHash = data.lastHash ?? '';
    } catch (_) {}
  }

  const hash = crypto
    .createHash('md5')
    .update(JSON.stringify(productsInput || []))
    .digest('hex');

  if (hash !== lastHash) {
    currentId += 1;
    fs.mkdirSync(path.dirname(counterPath), { recursive: true });
    fs.writeFileSync(
      counterPath,
      JSON.stringify({ currentId, lastHash: hash }, null, 2),
      'utf8'
    );
  }

  return String(currentId).padStart(3, '0');
}

function buildQuoteData(input) {
  const now = new Date();
  const customer = input.customer || {};

  const customerName = input.customerName || customer.name || 'KHÁCH HÀNG';
  const customerReceiver = input.customerReceiver || customer.receiver || customer.contact || '..................';
  const customerPhone = input.customerPhone || customer.phone || '..................';
  const customerEmail = input.customerEmail || customer.email || '..............................';
  const customerDepartment = input.customerDepartment || customer.department || '..................';

  const productsInput =
    Array.isArray(input.products) && input.products.length > 0
      ? input.products.map((p) => ({
          productTitle: p.productTitle || '',
          productContent: p.productContent || '',
          origin: p.origin || '',
          unit: p.unit || '',
          quantity: normalizeNumber(p.quantity, 1),
          unitPrice: normalizeNumber(p.unitPrice, 0)
        }))
      : Array.isArray(input.items) && input.items.length > 0
      ? input.items.map((p) => {
          const quantity = normalizeNumber(p.quantity, 1);
          const costPrice = normalizeNumber(p.costPrice ?? p.unitPrice, 0);
          const profitRate = normalizeNumber(p.profitRate ?? input.profitRate, 12);
          const salePrice = Math.round(costPrice * (1 + profitRate / 100));

          return {
            productTitle: p.description || p.productTitle || 'SẢN PHẨM',
            productContent: p.productContent || '',
            origin: p.origin || 'Việt Nam',
            unit: p.unit || 'Bộ',
            quantity,
            unitPrice: salePrice
          };
        })
      : [
          {
            productTitle: input.productTitle || 'SẢN PHẨM',
            productContent: input.productContent || '',
            origin: input.origin || 'Việt Nam',
            unit: input.unit || 'Bộ',
            quantity: normalizeNumber(input.quantity, 1),
            unitPrice: normalizeNumber(input.unitPrice, 0)
          }
        ];

  let calcSubtotal = 0;
  const processedProducts = productsInput.map((p) => {
    const q = normalizeNumber(p.quantity, 1);
    const price = normalizeNumber(p.unitPrice, 0);
    const lineTotal = Math.round(q * price);
    calcSubtotal += lineTotal;

    return {
      productTitle: p.productTitle || '',
      productContent: p.productContent || '',
      origin: p.origin || '',
      unit: p.unit || '',
      quantity: String(q),
      unitPrice: formatMoney(price),
      lineTotal: formatMoney(lineTotal)
    };
  });

  let productRows = '';
  processedProducts.forEach((p, index) => {
    productRows += `
      <tr>
        <td class="center">${index + 1}</td>
        <td>
          <div class="product-name">${p.productTitle}</div>
          <div class="product-lines">${p.productContent}</div>
        </td>
        <td class="center">${p.origin}</td>
        <td class="center">${p.unit}</td>
        <td class="center">${p.quantity}</td>
        <td class="right">${p.unitPrice}</td>
        <td class="right">${p.lineTotal}</td>
      </tr>`;
  });

  const subtotal = normalizeNumber(input.subtotal, calcSubtotal);
  const vatPercent = normalizeNumber(input.vatPercent, 8);
  const vatAmount = normalizeNumber(input.vatAmount, Math.round(subtotal * vatPercent / 100));
  const grandTotal = normalizeNumber(input.grandTotal, subtotal + vatAmount);
  const quoteNumber = input.quoteNumber || getNextQuoteNumber(processedProducts);

  return {
    quoteNumber,
    customerReceiver,
    customerPhone,
    customerEmail,
    customerDepartment,
    day: String(input.day ?? now.getDate()).padStart(2, '0'),
    month: String(input.month ?? now.getMonth() + 1).padStart(2, '0'),
    year: String(input.year ?? now.getFullYear()),
    customerName,
    productRows,
    subtotal: input.subtotalText || formatMoney(subtotal),
    vatPercent: String(vatPercent),
    vatAmount: input.vatAmountText || formatMoney(vatAmount),
    grandTotal: input.grandTotalText || formatMoney(grandTotal),
    amountInWords: input.amountInWords || numberToVietnamese(grandTotal)
  };
}

module.exports = { buildQuoteData, formatMoney, numberToVietnamese };
