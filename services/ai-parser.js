const { config } = require('./config');
const { createScope } = require('./logger');
const { parseQuoteRequest } = require('./telegram-parser');

const log = createScope('ai-parser');

function buildPrompt(text) {
  return [
    'Bạn là bộ trích xuất dữ liệu báo giá.',
    'Nhiệm vụ: đọc tin nhắn tiếng Việt của người dùng và trả về JSON hợp lệ duy nhất.',
    'Không giải thích. Không markdown. Không thêm chữ ngoài JSON.',
    'Nếu thiếu dữ liệu thì để chuỗi rỗng hoặc số 0.',
    'Schema JSON:',
    JSON.stringify({
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
      profitRate: 12,
      vatPercent: 8
    }),
    'Tin nhắn người dùng:',
    text
  ].join('\n');
}

async function parseWithOpenAI(text) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.aiApiKey}`
    },
    body: JSON.stringify({
      model: config.aiModel || 'gpt-4.1-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'Chỉ trả về JSON hợp lệ, không giải thích.'
        },
        {
          role: 'user',
          content: buildPrompt(text)
        }
      ]
    })
  });

  if (!response.ok) {
    const msg = await response.text();
    throw new Error(`OpenAI API lỗi ${response.status}: ${msg}`);
  }

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('AI không trả nội dung.');

  return JSON.parse(content);
}

function normalizeAiResult(parsed, defaults = {}) {
  return {
    customer: {
      name: parsed?.customer?.name || '',
      receiver: parsed?.customer?.receiver || '',
      department: parsed?.customer?.department || '',
      phone: parsed?.customer?.phone || '',
      email: parsed?.customer?.email || ''
    },
    items: Array.isArray(parsed?.items)
      ? parsed.items.map((item) => ({
          description: item?.description || '',
          origin: item?.origin || '',
          unit: item?.unit || '',
          quantity: Number(item?.quantity || 0),
          costPrice: Number(item?.costPrice || 0),
          productContent: item?.productContent || ''
        }))
      : [],
    profitRate: Number(parsed?.profitRate || defaults.defaultProfitRate || 12),
    vatPercent: Number(parsed?.vatPercent || defaults.defaultVatPercent || 8)
  };
}

async function parseQuoteRequestWithAI(text, defaults = {}) {
  if (!config.aiEnabled || !config.aiApiKey || config.aiProvider !== 'openai') {
    return {
      payload: parseQuoteRequest(text, defaults),
      mode: 'rule-based'
    };
  }

  try {
    const aiRaw = await parseWithOpenAI(text);
    const payload = normalizeAiResult(aiRaw, defaults);
    log.info('AI parse thành công');
    return { payload, mode: 'ai' };
  } catch (err) {
    log.warn('AI parse lỗi, fallback parser thường', err.message);
    return {
      payload: parseQuoteRequest(text, defaults),
      mode: 'fallback-rule-based'
    };
  }
}

module.exports = { parseQuoteRequestWithAI };
