function sanitizeLine(line) {
  return String(line || '')
    .replace(/\s+/g, ' ')
    .replace(/[|]+/g, ' | ')
    .trim();
}

function normalizeMoney(value) {
  return String(value || '')
    .replace(/[₫đĐ,\s]/g, '')
    .replace(/\.(?=\d{3}(\D|$))/g, '')
    .replace(/[^\d.-]/g, '');
}

function extractRowsFromOcrText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(sanitizeLine)
    .filter(Boolean);

  const rows = [];
  let current = null;

  for (const line of lines) {
    const startMatch = line.match(/^(\d{1,2})\s+/);
    if (startMatch) {
      if (current) rows.push(current.trim());
      current = line;
    } else if (current) {
      current += ' ' + line;
    }
  }

  if (current) rows.push(current.trim());
  return rows;
}

function toCompactQuoteText(ocrText) {
  const rows = extractRowsFromOcrText(ocrText);
  const compact = [];

  for (const row of rows) {
    const cleaned = row.replace(/\s+/g, ' ').trim();
    const sttMatch = cleaned.match(/^(\d{1,2})\s+(.*)$/);
    if (!sttMatch) continue;

    const body = sttMatch[2];
    const moneyMatches = [...body.matchAll(/(\d[\d\.,\s]{2,})\s*[₫đĐ]?/g)].map(m => m[1]);
    if (moneyMatches.length < 2) continue;

    const unitQtySegment = body.match(/\b(Bộ|Cái|Mét|Gói|Sợi|Thùng|Chiếc|bộ|cái|mét|gói|sợi|chiếc)\b\s+(\d+)/i);
    if (!unitQtySegment) continue;

    const unit = unitQtySegment[1];
    const quantity = unitQtySegment[2];
    const unitPrice = normalizeMoney(moneyMatches[0]);
    const description = body.slice(0, unitQtySegment.index).trim().replace(/\s+/g, ' ');

    compact.push(`${sttMatch[1]}. ${description} | ${unit} | ${quantity} | ${unitPrice}`);
  }

  return compact.join('\n');
}

module.exports = {
  extractRowsFromOcrText,
  toCompactQuoteText,
  normalizeMoney
};
