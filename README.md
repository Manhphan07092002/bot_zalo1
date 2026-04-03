# CTC Quote Bot

Bot tạo bảng chào giá PDF theo mẫu cố định của CTC.

## Tính năng hiện có
- Tạo PDF báo giá từ JSON
- API nội bộ `POST /api/quote`
- Bot Telegram nhận nội dung text rồi trả lại file PDF
- Healthcheck `GET /health`
- Version endpoint `GET /version`
- Lưu lịch sử báo giá gần nhất
- Có thể tích hợp AI để phân tích đầu vào thành JSON chuẩn
- Hỗ trợ tiếng Việt ổn định khi render PDF

## Cài đặt
```bash
npm install
cp .env.example .env
```

Điền các biến trong `.env`:
```env
PORT=3000
QUOTE_API_URL=http://127.0.0.1:3000/api/quote
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
DEFAULT_PROFIT_RATE=12
DEFAULT_VAT_PERCENT=8
AI_ENABLED=false
AI_PROVIDER=openai
AI_API_KEY=your_ai_api_key_here
AI_MODEL=gpt-4.1-mini
```

## Chạy local
### API server
```bash
npm start
```

### Telegram bot
```bash
npm run telegram
```

### Tạo file mẫu
```bash
npm run example
```

## API
### `POST /api/quote`
Nhận JSON đầu vào và trả file PDF.

### `GET /health`
Kiểm tra service còn sống.

### `GET /version`
Xem tên app và version hiện tại.

## Mẫu nhập Telegram
```text
Khách hàng: VIỄN THÔNG HUẾ
Người nhận: Nguyễn Bá Toàn
Bộ phận: Kỹ thuật
Điện thoại: 0912345678
Email: abc@example.com

Hàng hóa:
1. Bộ chuyển đổi tín hiệu Mini Converter SDI to HDMI 6G | China | cái | 2 | 1.850.000 | Ghi chú tùy chọn

Lãi suất: 12
VAT: 8
```

## Cấu trúc chính
- `server.js`: API tạo PDF
- `telegram-bot.js`: bot Telegram
- `services/config.js`: nạp cấu hình `.env`
- `services/telegram-parser.js`: parse và validate nội dung Telegram
- `services/ai-parser.js`: dùng AI để chuyển đầu vào tự nhiên thành JSON chuẩn
- `services/quote-data.js`: xử lý dữ liệu báo giá
- `services/history-store.js`: cấp số báo giá có lock file và lưu lịch sử
- `services/render-quote-pdf.js`: render HTML sang PDF bằng Puppeteer
- `templates/bao-gia-ctc.html`: mẫu PDF

## Ghi chú
- File `.env` đã được ignore trong git
- Thư mục `output/` cũng đã ignore
- Nếu chạy bằng PM2, nhớ restart lại process sau khi sửa code
- Lịch sử báo giá lưu ở `data/quote-history.json`
- Nếu chưa bật AI hoặc AI lỗi, hệ thống sẽ tự fallback về parser thường
