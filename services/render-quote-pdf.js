const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

function fileToDataUri(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml'
  };
  const mimeType = mimeMap[ext] || 'application/octet-stream';
  const base64 = fs.readFileSync(filePath).toString('base64');
  return `data:${mimeType};base64,${base64}`;
}

function replaceAll(template, data) {
  let html = template;
  for (const [key, value] of Object.entries(data)) {
    let safe = String(value ?? '');
    if (key !== 'productRows') {
      safe = safe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
    html = html.split(`{{${key}}}`).join(safe);
  }
  return html;
}

async function renderQuotePdf({ templatePath, outputPath, data }) {
  const template = fs.readFileSync(templatePath, 'utf8');
  const logoPath = path.resolve(__dirname, '..', 'assets', 'ctc-logo.gif');
  const html = replaceAll(template, {
    ...data,
    logoDataUri: fileToDataUri(logoPath)
  });

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true
    });
  } finally {
    await browser.close();
  }

  return outputPath;
}

module.exports = { renderQuotePdf };
