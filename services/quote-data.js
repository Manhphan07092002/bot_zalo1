const fs = require('fs');
const path = require('path');

function getNextQuoteNumber(productsInput) {
  const counterPath = path.resolve(__dirname, '..', 'data', 'counter.json');
  let currentId = 0;
  let lastHash = '';
  if (fs.existsSync(counterPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
      currentId = data.currentId ?? (data.count ? data.count - 1 : 0);
      lastHash = data.lastHash || '';
    } catch (e) {}
  }
  
  const currentHash = JSON.stringify(productsInput);
  
  if (currentHash !== lastHash) {
    currentId += 1;
    // Lưu lại đếm tiếp theo và hash hiện tại
    fs.writeFileSync(counterPath, JSON.stringify({ currentId, lastHash: currentHash }), 'utf8');
  } else if (currentId === 0) {
    currentId = 1;
  }
  
  // Format thành chuỗi vd: 001, 012, 125
  return String(currentId).padStart(3, '0');
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString('vi-VN');
}

function numberToVietnamese(n) {
  const digits = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
  const units = ['', ' nghìn', ' triệu', ' tỷ', ' nghìn tỷ'];

  if (n === 0) return 'Không đồng chẵn';

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

function buildQuoteData(input) {
  const now = new Date();
  
  // Nếu có mảng products thì ưu tiên, ngược lại lấy các trường phẳng cũ (đảm bảo tương thích ngược)
  const productsInput = Array.isArray(input.products) && input.products.length > 0 
    ? input.products 
    : [
        {
          productTitle: input.productTitle || 'SẢN PHẨM',
          productContent: input.productContent || '',
          origin: input.origin || 'Việt Nam',
          unit: input.unit || 'Bộ',
          quantity: input.quantity ?? 1,
          unitPrice: input.unitPrice ?? (input.subtotal ?? input.lineTotal ?? 0)
        }
      ];

  let calcSubtotal = 0;
  const processedProducts = productsInput.map(p => {
    const q = Number(p.quantity ?? 1);
    const pPrice = Number(p.unitPrice ?? 0);
    const lTotal = q * pPrice;
    calcSubtotal += lTotal;

    return {
      productTitle: p.productTitle || '',
      productContent: p.productContent || '',
      origin: p.origin || '',
      unit: p.unit || '',
      quantity: String(q),
      unitPrice: formatMoney(pPrice),
      lineTotal: formatMoney(lTotal)
    };
  });

  const subtotal = Number(input.subtotal ?? calcSubtotal);
  const vatPercent = Number(input.vatPercent ?? 8);
  const vatAmount = Number(input.vatAmount ?? Math.round(subtotal * vatPercent / 100));
  const grandTotal = Number(input.grandTotal ?? subtotal + vatAmount);

  // Sinh sẵn HTML các dòng <tr> sản phẩm để nhúng vào template
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

  const quoteNumber = input.quoteNumber || getNextQuoteNumber(processedProducts);

  return {
    quoteNumber: quoteNumber,
    customerReceiver: input.customerReceiver || '..................',
    customerPhone: input.customerPhone || '..................',
    customerEmail: input.customerEmail || '..............................',
    customerDepartment: input.customerDepartment || '..................',
    day: String(input.day ?? now.getDate()).padStart(2, '0'),
    month: String(input.month ?? now.getMonth() + 1).padStart(2, '0'),
    year: String(input.year ?? now.getFullYear()),
    customerName: input.customerName || 'KHÁCH HÀNG',
    productRows: productRows,
    subtotal: input.subtotalText || formatMoney(subtotal),
    vatPercent: String(vatPercent),
    vatAmount: input.vatAmountText || formatMoney(vatAmount),
    grandTotal: input.grandTotalText || formatMoney(grandTotal),
    amountInWords: input.amountInWords || numberToVietnamese(grandTotal)
  };
}

module.exports = { buildQuoteData, formatMoney, numberToVietnamese };
