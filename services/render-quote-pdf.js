const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

function fileToDataUri(filePath) {
  if (!fs.existsSync(filePath)) return '';

  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
  };

  const mimeType = mimeMap[ext] || 'application/octet-stream';
  const base64 = fs.readFileSync(filePath).toString('base64');
  return `data:${mimeType};base64,${base64}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function replaceAll(template, data) {
  let html = template;

  for (const [key, value] of Object.entries(data)) {
    const safeValue = key === 'productRows' ? String(value ?? '') : escapeHtml(value);
    html = html.split(`{{${key}}}`).join(safeValue);
  }

  return html;
}

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--allow-file-access-from-files'
      ]
    });
  }
  return browserInstance;
}

function injectFontFaces(html) {
  const regularPath = '/usr/share/fonts/truetype/msttcorefonts/Times_New_Roman.ttf';
  const boldPath = '/usr/share/fonts/truetype/msttcorefonts/Times_New_Roman_Bold.ttf';
  const italicPath = '/usr/share/fonts/truetype/msttcorefonts/Times_New_Roman_Italic.ttf';
  const boldItalicPath = '/usr/share/fonts/truetype/msttcorefonts/Times_New_Roman_Bold_Italic.ttf';

  let fontCss = '';

  if (fs.existsSync(regularPath)) {
    fontCss += `
@font-face {
  font-family: "Times New Roman Local";
  src: url("${fileToDataUri(regularPath)}") format("truetype");
  font-weight: normal;
  font-style: normal;
}
`;
  }

  if (fs.existsSync(boldPath)) {
    fontCss += `
@font-face {
  font-family: "Times New Roman Local";
  src: url("${fileToDataUri(boldPath)}") format("truetype");
  font-weight: bold;
  font-style: normal;
}
`;
  }

  if (fs.existsSync(italicPath)) {
    fontCss += `
@font-face {
  font-family: "Times New Roman Local";
  src: url("${fileToDataUri(italicPath)}") format("truetype");
  font-weight: normal;
  font-style: italic;
}
`;
  }

  if (fs.existsSync(boldItalicPath)) {
    fontCss += `
@font-face {
  font-family: "Times New Roman Local";
  src: url("${fileToDataUri(boldItalicPath)}") format("truetype");
  font-weight: bold;
  font-style: italic;
}
`;
  }

  if (!fontCss) return html;

  if (html.includes('<style>')) {
    return html.replace('<style>', `<style>\n${fontCss}\n`);
  }

  return `<style>${fontCss}</style>\n${html}`;
}

async function renderQuotePdf({ templatePath, outputPath, data }) {
  if (!templatePath) throw new Error('Thiếu templatePath');
  if (!outputPath) throw new Error('Thiếu outputPath');

  const template = fs.readFileSync(templatePath, 'utf8');
  const logoPath = path.resolve(__dirname, '..', 'assets', 'ctc-logo.gif');

  let html = replaceAll(template, {
    ...data,
    logoDataUri: fileToDataUri(logoPath)
  });

  html = injectFontFaces(html);

  const browser = await getBrowser();
  let page;

  try {
    page = await browser.newPage();

    await page.setViewport({
      width: 1240,
      height: 1754,
      deviceScaleFactor: 1
    });

    await page.setContent(html, {
      waitUntil: 'networkidle0'
    });

    await page.evaluate(async () => {
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }
    });

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: '0',
        right: '0',
        bottom: '0',
        left: '0'
      }
    });

    return outputPath;
  } catch (error) {
    throw new Error(`Không thể render PDF: ${error.message}`);
  } finally {
    if (page) {
      await page.close();
    }
  }
}

async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

module.exports = {
  renderQuotePdf,
  closeBrowser
};
