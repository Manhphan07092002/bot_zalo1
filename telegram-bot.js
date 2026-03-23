const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Thiếu TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function extractFieldFromLines(lines, label) {
  const lowerLabel = label.toLowerCase();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const idx = line.indexOf(':');
    if (idx === -1) continue;

    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === lowerLabel) {
      return value;
    }
  }

  return '';
}

function parseItems(text) {
  const lines = text
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

  const items = [];

  for (const line of lines) {
    const cleaned = line.replace(/^\d+\.\s*/, '');
    const parts = cleaned.split('|').map(s => s.trim());

    if (parts.length >= 5) {
      const quantity = Number(String(parts[3] || '').replace(/[^\d.-]/g, ''));
      const costPrice = Number(String(parts[4] || '').replace(/[^\d.-]/g, ''));

      items.push({
        description: parts[0] || '',
        origin: parts[1] || '',
        unit: parts[2] || '',
        quantity: Number.isFinite(quantity) ? quantity : 0,
        costPrice: Number.isFinite(costPrice) ? costPrice : 0
      });
    }
  }

  return items;
}

function parseQuoteRequest(text) {
  const lines = text.split('\n');

  const customerName = extractFieldFromLines(lines, 'Khách hàng');
  const customerReceiver = extractFieldFromLines(lines, 'Người nhận');
  const customerDepartment = extractFieldFromLines(lines, 'Bộ phận');
  const phone = extractFieldFromLines(lines, 'Điện thoại');
  const email = extractFieldFromLines(lines, 'Email');

  const profitRateRaw = extractFieldFromLines(lines, 'Lãi suất');
  const profitRate = profitRateRaw
    ? Number(String(profitRateRaw).replace(/[^\d.-]/g, ''))
    : 12;

  let itemsBlock = '';
  const hangHoaIndex = lines.findIndex(line => /^\s*Hàng hóa\s*:/i.test(line));

  if (hangHoaIndex !== -1) {
    itemsBlock = lines.slice(hangHoaIndex + 1).join('\n');
  }

  const items = parseItems(itemsBlock);

  return {
    customer: {
      name: customerName || '',
      receiver: customerReceiver || '',
      department: customerDepartment || '',
      phone: phone || '',
      email: email || ''
    },
    items,
    profitRate: Number.isFinite(profitRate) ? profitRate : 12
  };
}

function validatePayload(payload) {
  if (!payload.customer?.name) {
    return 'Thiếu tên khách hàng.';
  }

  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return 'Thiếu danh sách hàng hóa.';
  }

  for (const item of payload.items) {
    if (!item.description) return 'Có mặt hàng thiếu mô tả.';
    if (!(item.quantity > 0)) return `Mặt hàng "${item.description}" thiếu hoặc sai số lượng.`;
    if (!(item.costPrice > 0)) return `Mặt hàng "${item.description}" thiếu hoặc sai đơn giá nhập.`;
  }

  return null;
}

async function createQuotePdf(payload) {
  const res = await fetch('http://127.0.0.1:3000/api/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
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
  const buffer = Buffer.from(arrayBuffer);

  return { buffer, fileName };
}

bot.onText(/\/start/i, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    [
      'Bot báo giá CTC đã sẵn sàng.',
      '',
      'Mẫu nhập:',
      'Khách hàng: VIỄN THÔNG HUẾ',
      'Người nhận: Nguyễn Bá Toàn',
      'Bộ phận:',
      'Điện thoại: 0912345678',
      'Email: abc@example.com',
      '',
      'Hàng hóa:',
      '1. Bộ chuyển đổi tín hiệu Mini Converter SDI to HDMI 6G | China | cái | 2 | 1850000',
      '',
      'Lãi suất: 12'
    ].join('\n')
  );
});

bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    if (!text || text.startsWith('/start')) return;

    const payload = parseQuoteRequest(text);
    const validationError = validatePayload(payload);

    if (validationError) {
      await bot.sendMessage(chatId, `Chưa tạo được báo giá. ${validationError}`);
      return;
    }

    await bot.sendMessage(chatId, `Em đang tạo báo giá cho ${payload.customer.name}...`);

    const { buffer, fileName } = await createQuotePdf(payload);

    await bot.sendDocument(
      chatId,
      buffer,
      {
        caption: `Báo giá đã tạo xong cho ${payload.customer.name}. Em gửi file PDF đính kèm bên dưới.`
      },
      {
        filename: fileName,
        contentType: 'application/pdf'
      }
    );
  } catch (err) {
    console.error('Lỗi bot Telegram:', err);
    try {
      await bot.sendMessage(
        msg.chat.id,
        `Chưa tạo được báo giá. Lý do: ${err.message}`
      );
    } catch (_) {}
  }
});

console.log('Telegram bot đang chạy...');
