const { config } = require('./config');
const { createScope } = require('./logger');
const { normalizeAiResult } = require('./ai-parser');

const log = createScope('ai-input-parser');

function schemaExample() {
  return JSON.stringify({
    customer: {
      name: '',
      receiver: '',
      department: '',
      phone: '',
      email: ''
    },
    items: [
      {
        description: '',
        origin: '',
        unit: '',
        quantity: 0,
        costPrice: 0,
        productContent: ''
      }
    ],
    profitRate: 0,
    vatPercent: 0,
    meta: {
      deliveryDaysText: '',
      paymentDaysText: '',
      warrantyMonthsText: '',
      quoteValidityDaysText: '',
      signerChoice: ''
    }
  });
}

function buildTextPrompt(text) {
  return [
    'Bạn là bộ phân tích đầu vào báo giá.',
    'Nhiệm vụ: nhận toàn bộ nội dung người dùng và trả về JSON hợp lệ duy nhất theo schema.',
    'Không giải thích. Không markdown. Chỉ trả về JSON.',
    'Nếu thiếu dữ liệu thì để chuỗi rỗng hoặc số 0.',
    'Nếu người dùng nêu rõ lãi hoặc VAT thì điền vào. Nếu không rõ thì để 0.',
    'Schema JSON:',
    schemaExample(),
    'Đầu vào:',
    text
  ].join('\n');
}

function buildVisionPrompt(captionText = '') {
  return [
    'Bạn là bộ phân tích đầu vào báo giá từ ảnh/caption.',
    'Hãy dùng cả ảnh và caption (nếu có) để trích xuất JSON hợp lệ duy nhất theo schema.',
    'Không giải thích. Không markdown. Chỉ trả về JSON.',
    'Ưu tiên đọc đúng tên khách hàng, hàng hóa, đơn vị, số lượng, giá nhập.',
    'Nếu caption có thông tin như lãi, VAT, khách hàng, người nhận thì ưu tiên dùng caption.',
    'Nếu thiếu dữ liệu thì để chuỗi rỗng hoặc số 0.',
    'Schema JSON:',
    schemaExample(),
    captionText ? `Caption kèm theo:\n${captionText}` : 'Không có caption.'
  ].join('\n');
}

function getGeminiApiKeys() {
  const keys = [...(config.aiApiKeys || [])];
  if (config.aiApiKey) keys.unshift(config.aiApiKey);
  return [...new Set(keys.filter(Boolean))];
}

async function callGemini(parts) {
  const keys = getGeminiApiKeys();
  if (!keys.length) throw new Error('Thiếu GEMINI API key.');

  const model = config.aiModel || 'gemini-2.5-flash';
  let lastError = null;

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json'
        },
        contents: [{ role: 'user', parts }]
      })
    });

    if (!res.ok) {
      const msg = await res.text();
      lastError = new Error(`Gemini API lỗi ${res.status}: ${msg}`);
      continue;
    }

    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) {
      lastError = new Error('Gemini không trả nội dung.');
      continue;
    }

    return JSON.parse(text);
  }

  throw lastError || new Error('Gemini thất bại với mọi key.');
}

async function parseUnifiedInput({ text = '', imageBuffer = null, mimeType = 'image/jpeg' }, defaults = {}) {
  let raw;

  if (imageBuffer) {
    raw = await callGemini([
      { text: buildVisionPrompt(text) },
      {
        inlineData: {
          mimeType,
          data: imageBuffer.toString('base64')
        }
      }
    ]);
    log.info('AI parse unified từ ảnh/caption thành công');
  } else {
    raw = await callGemini([{ text: buildTextPrompt(text) }]);
    log.info('AI parse unified từ text thành công');
  }

  return normalizeAiResult(raw, defaults);
}

module.exports = { parseUnifiedInput };
