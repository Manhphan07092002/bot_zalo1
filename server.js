const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { renderQuotePdf } = require('./services/render-quote-pdf');
const { buildQuoteData } = require('./services/quote-data');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/quote', async (req, res) => {
  try {
    const inputData = req.body;
    
    // Nếu payload trống
    if (!inputData || Object.keys(inputData).length === 0) {
      return res.status(400).json({ error: 'Payload không hợp lệ' });
    }

    const data = buildQuoteData(inputData);
    
    // Đặt tên file ngẫu nhiên dựa trên timestamp
    const fileName = `${data.quoteNumber}-bao-gia-${Date.now()}.pdf`;
    const outputPath = path.resolve(__dirname, 'output', fileName);
    const templatePath = path.resolve(__dirname, 'templates', 'bao-gia-ctc.html');

    // Tạo PDF
    await renderQuotePdf({
      templatePath,
      outputPath,
      data
    });

    // Stream file PDF về cho client
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${data.quoteNumber}-bao-gia-ctc.pdf"`);
    
    const fileStream = fs.createReadStream(outputPath);
    fileStream.pipe(res);

    // Có thể tự động xóa PDF sau khi gửi xong để nhẹ dung lượng đĩa
    fileStream.on('end', () => {
      fs.unlink(outputPath, (err) => {
        if (err) console.error('Lỗi xóa file PDF tải qua API:', err);
      });
    });

  } catch (err) {
    console.error('Lỗi tạo API báo giá:', err);
    res.status(500).json({ error: 'Lỗi server khi tạo báo giá', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server API đang chạy tại http://localhost:${PORT}`);
  console.log(`✨ Bạn có thể gửi requests POST (JSON) tới: http://localhost:${PORT}/api/quote để nhận file PDF trả về trực tiếp.`);
});
