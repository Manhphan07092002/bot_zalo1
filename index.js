const fs = require('fs');
const path = require('path');
const { renderQuotePdf } = require('./services/render-quote-pdf');
const { buildQuoteData } = require('./services/quote-data');

function getArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

async function main() {
  const inputPath = path.resolve(getArg('--input', './data/example.json'));
  let outputPath = path.resolve(getArg('--output', './output/bao-gia.pdf'));
  const templatePath = path.resolve('./templates/bao-gia-ctc.html');

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Không tìm thấy file input: ${inputPath}`);
  }
  
  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const data = buildQuoteData(raw);

  const dir = path.dirname(outputPath);
  const ext = path.extname(outputPath);
  const base = path.basename(outputPath, ext);
  
  if (!base.startsWith(data.quoteNumber)) {
    outputPath = path.join(dir, `${data.quoteNumber}-${base}${ext}`);
  }

  await renderQuotePdf({
    templatePath,
    outputPath,
    data
  });

  console.log(`Đã tạo PDF: ${outputPath}`);
}

main().catch((err) => {
  console.error('Lỗi tạo báo giá:', err.message);
  process.exit(1);
});
