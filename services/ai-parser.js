const { execFile } = require('child_process');
const { promisify } = require('util');
const { config } = require('./config');
const { createScope } = require('./logger');
const { parseQuoteRequest } = require('./telegram-parser');

const execFileAsync = promisify(execFile);

const log = createScope('ai-parser');

function getJsonSchemaExample() {
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
    profitRate: 12,
    vatPercent: 8
  });
}

function buildPrompt(text) {
  return [
    'Bạn là bộ trích xuất dữ liệu báo giá.',
    'Nhiệm vụ: đọc tin nhắn tiếng Việt của người dùng và trả về JSON hợp lệ duy nhất.',
    'Không giải thích. Không markdown. Không thêm chữ ngoài JSON.',
    'Nếu thiếu dữ liệu thì để chuỗi rỗng hoặc số 0.',
    'Chỉ điền profitRate và vatPercent nếu người dùng nêu rõ ràng trong nội dung như lãi 15%, VAT 10%. Nếu không rõ thì để 0 hoặc bỏ trống để hệ thống dùng mặc định.',
    'Schema JSON:',
    getJsonSchemaExample(),
    'Tin nhắn người dùng:',
    text
  ].join('\n');
}

function buildVisionPrompt() {
  return [
    'Hãy đọc ảnh bảng báo giá/dự toán bằng tiếng Việt và trích xuất thành JSON hợp lệ duy nhất.',
    'Không giải thích. Không markdown. Chỉ trả về JSON.',
    'Ưu tiên lấy đúng tên hàng, đơn vị tính, số lượng và đơn giá.',
    'Bỏ qua các cột thành tiền, VAT, tổng sau thuế nếu có.',
    'Nếu ảnh không có trường Khách hàng rõ ràng, hãy suy ra customer.name từ tên đơn vị nổi bật trong tiêu đề, công trình hoặc hạng mục.',
    'Ưu tiên các tên đơn vị như: Trường, Viễn thông, Bệnh viện, UBND, Công ty, Trung tâm.',
    'Nếu trong ảnh có cả Công trình và Hạng mục, hãy chọn tên đơn vị/cơ quan/khách hàng chứ không lấy nguyên cả câu mô tả dài nếu không cần thiết.',
    'Nếu thiếu trường thì để chuỗi rỗng hoặc số 0.',
    'Chỉ điền profitRate và vatPercent nếu trong ảnh có ghi rõ ràng. Nếu không rõ thì để 0 hoặc bỏ trống để hệ thống dùng mặc định.',
    'Schema JSON:',
    getJsonSchemaExample()
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

function refineCustomerName(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';

  const patterns = [
    /(Trường\s+[A-ZÀ-Ỵa-zà-ỵ0-9&.\-\s]+)/i,
    /(Viễn\s*thông\s+[A-ZÀ-Ỵa-zà-ỵ0-9&.\-\s]+)/i,
    /(Bệnh\s*viện\s+[A-ZÀ-Ỵa-zà-ỵ0-9&.\-\s]+)/i,
    /(UBND\s+[A-ZÀ-Ỵa-zà-ỵ0-9&.\-\s]+)/i,
    /(Công\s*ty\s+[A-ZÀ-Ỵa-zà-ỵ0-9&.\-\s]+)/i,
    /(Trung\s*tâm\s+[A-ZÀ-Ỵa-zà-ỵ0-9&.\-\s]+)/i
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match) {
      return match[1]
        .replace(/\s+năm\s+\d{4}$/i, '')
        .replace(/[\s\-:,;]+$/g, '')
        .trim();
    }
  }

  return raw
    .replace(/\s+năm\s+\d{4}$/i, '')
    .replace(/[\s\-:,;]+$/g, '')
    .trim();
}

function normalizeAiResult(parsed, defaults = {}) {
  const explicitProfitRate = Number(parsed?.profitRate);
  const explicitVatPercent = Number(parsed?.vatPercent);
  const hasExplicitProfitRate = parsed?.profitRate !== undefined && parsed?.profitRate !== null && parsed?.profitRate !== '';
  const hasExplicitVatPercent = parsed?.vatPercent !== undefined && parsed?.vatPercent !== null && parsed?.vatPercent !== '';

  return {
    customer: {
      name: refineCustomerName(parsed?.customer?.name || ''),
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
    profitRate: hasExplicitProfitRate && Number.isFinite(explicitProfitRate) && explicitProfitRate > 0 ? explicitProfitRate : Number(defaults.defaultProfitRate || 12),
    vatPercent: hasExplicitVatPercent && Number.isFinite(explicitVatPercent) ? explicitVatPercent : Number(defaults.defaultVatPercent || 8)
  };
}

async function parseWithGeminiCli(text) {
  const prompt = buildPrompt(text);
  const args = ['-p', prompt, '--output-format', 'json', '--yolo'];

  if (config.aiModel) {
    args.push('--model', config.aiModel);
  }

  const { stdout, stderr } = await execFileAsync('gemini', args, {
    timeout: 60000,
    maxBuffer: 1024 * 1024
  });

  const raw = String(stdout || '').trim();
  if (!raw) {
    throw new Error(`Gemini CLI không trả dữ liệu. ${String(stderr || '').trim()}`.trim());
  }

  const parsedOuter = JSON.parse(raw);
  const textOutput = parsedOuter.response || parsedOuter.text || parsedOuter.output || raw;

  if (typeof textOutput === 'object' && textOutput !== null) {
    return textOutput;
  }

  return JSON.parse(String(textOutput).trim());
}

function getGeminiApiKeys() {
  const keys = [...(config.aiApiKeys || [])];
  if (config.aiApiKey) keys.unshift(config.aiApiKey);
  return [...new Set(keys.filter(Boolean))];
}

function shouldTryNextGeminiKey(status, message) {
  const msg = String(message || '').toLowerCase();
  return status === 429 || status === 403 || status === 401 || msg.includes('quota') || msg.includes('rate') || msg.includes('exceeded') || msg.includes('invalid api key');
}

async function callGeminiApi(parts) {
  const keys = getGeminiApiKeys();
  if (!keys.length) {
    throw new Error('Thiếu GEMINI API key.');
  }

  const model = config.aiModel || 'gemini-2.5-flash';
  let lastError = null;

  for (let i = 0; i < keys.length; i += 1) {
    const apiKey = keys[i];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json'
        },
        contents: [
          {
            role: 'user',
            parts
          }
        ]
      })
    });

    if (!response.ok) {
      const msg = await response.text();
      lastError = new Error(`Gemini API lỗi ${response.status}: ${msg}`);

      if (i < keys.length - 1 && shouldTryNextGeminiKey(response.status, msg)) {
        log.warn(`Gemini key ${i + 1}/${keys.length} lỗi, thử key tiếp theo`);
        continue;
      }

      throw lastError;
    }

    const json = await response.json();
    const content = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!content) {
      lastError = new Error('Gemini API không trả nội dung.');
      if (i < keys.length - 1) continue;
      throw lastError;
    }

    return JSON.parse(content);
  }

  throw lastError || new Error('Gemini API thất bại với mọi key.');
}

async function parseWithGeminiApi(text) {
  return callGeminiApi([{ text: buildPrompt(text) }]);
}

async function parseImageWithGeminiVision(imageBuffer, mimeType = 'image/jpeg') {
  try {
    return await callGeminiApi([
      { text: buildVisionPrompt() },
      {
        inlineData: {
          mimeType,
          data: imageBuffer.toString('base64')
        }
      }
    ]);
  } catch (firstError) {
    log.warn('Gemini vision lần 1 lỗi, thử lại với prompt tăng cường', firstError.message);
    return callGeminiApi([
      {
        text: `${buildVisionPrompt()}\nẢnh có thể là screenshot nhỏ hoặc ảnh bảng nén. Hãy cố đọc kỹ tên khách hàng, tên hàng, đơn vị, số lượng, giá nhập. Nếu chỉ đọc được một phần thì vẫn trả các item đọc chắc chắn nhất.`
      },
      {
        inlineData: {
          mimeType,
          data: imageBuffer.toString('base64')
        }
      }
    ]);
  }
}

async function parseQuoteRequestWithAI(text, defaults = {}) {
  if (!config.aiEnabled) {
    return {
      payload: parseQuoteRequest(text, defaults),
      mode: 'rule-based'
    };
  }

  try {
    let aiRaw;

    if (config.aiProvider === 'openai' && config.aiApiKey) {
      aiRaw = await parseWithOpenAI(text);
    } else if (config.aiProvider === 'gemini-cli') {
      aiRaw = await parseWithGeminiCli(text);
    } else if (config.aiProvider === 'gemini-api') {
      aiRaw = await parseWithGeminiApi(text);
    } else {
      return {
        payload: parseQuoteRequest(text, defaults),
        mode: 'rule-based'
      };
    }

    const payload = normalizeAiResult(aiRaw, defaults);
    log.info('AI parse thành công');
    return { payload, mode: `ai-${config.aiProvider}` };
  } catch (err) {
    log.warn('AI parse lỗi, fallback parser thường', err.message);
    return {
      payload: parseQuoteRequest(text, defaults),
      mode: 'fallback-rule-based'
    };
  }
}

module.exports = { parseQuoteRequestWithAI, parseImageWithGeminiVision, normalizeAiResult };
