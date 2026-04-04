# CTC Quote Bot

Bot Telegram tạo báo giá PDF theo mẫu CTC.

## Tính năng chính
- Tạo PDF báo giá từ JSON
- API nội bộ `POST /api/quote`
- Bot Telegram nhận:
  - text
  - ảnh
  - caption
  - ảnh + caption
- Hỏi bổ sung từng bước nếu còn thiếu dữ liệu
- Hỗ trợ AI để phân tích đầu vào thành JSON
- Hỗ trợ đọc ảnh bảng và caption
- Lưu lịch sử báo giá
- Có healthcheck và version endpoint

## Luồng hoạt động
1. Nhận đầu vào từ Telegram
2. Phân tích dữ liệu
   - text rõ → parser thường trước
   - text khó / ảnh → AI xử lý
   - caption được dùng như nguồn dữ liệu bổ sung
3. Chuẩn hóa về JSON
4. Hỏi phần còn thiếu
5. Xuất PDF
6. Gửi file lại Telegram
7. Lưu bản PDF vào `output/sent/`

## Cài đặt
```bash
npm install
cp .env.example .env
```

## Cấu hình `.env`
```env
PORT=3000
HOST=127.0.0.1
NODE_ENV=production
LOG_LEVEL=info
API_KEY=your_internal_api_key
QUOTE_API_URL=http://127.0.0.1:3000/api/quote
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
TELEGRAM_ALLOWED_CHAT_IDS=
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=30
RENDER_TIMEOUT_MS=30000
CORS_ORIGINS=

COMPANY_NAME=CÔNG TY CỔ PHẦN XÂY LẮP BƯU ĐIỆN MIỀN TRUNG
COMPANY_ADDRESS=50B Nguyễn Du, Phường Hải Châu, Thành phố Đà Nẵng, Việt Nam.
COMPANY_PHONE=02363.745.745 - 02363.745.746
COMPANY_EMAIL=sales@ctcdn.vn
COMPANY_TAX_CODE=0400458940
COMPANY_WEBSITE=https://ctcdn.vn/
TIMEZONE=Asia/Ho_Chi_Minh

DEFAULT_PROFIT_RATE=12
DEFAULT_VAT_PERCENT=8

AI_PROVIDER=gemini-api
AI_MODEL=gemini-2.5-flash
AI_API_KEY=your_primary_gemini_api_key_here
AI_API_KEYS=your_backup_key_1,your_backup_key_2
OCR_ENABLED=true
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
### 1. Dạng rõ cấu trúc
```text
Tạo báo giá cho VIỄN THÔNG ĐÀ NẴNG.
Người nhận Nguyễn Bá Toàn, bộ phận Phòng Kỹ thuật, điện thoại 0912345678, email vantocdn@example.com.

Danh sách hàng:
1) Bộ chuyển đổi tín hiệu Mini Converter SDI to HDMI 6G, xuất xứ China, đơn vị cái, số lượng 10, giá nhập 2064732
2) Bộ chuyển đổi tín hiệu HDMI to SDI Mini Converter, xuất xứ China, đơn vị cái, số lượng 12, giá nhập 1841518

Lãi 15%, VAT 10%
```

### 2. Dạng pipe ngắn gọn
```text
Khách hàng: VIỄN THÔNG HUẾ
Người nhận: Nguyễn Bá Toàn
Bộ phận: Kỹ thuật
Điện thoại: 0912345678
Email: abc@example.com

Hàng hóa:
1. Bộ chuyển đổi tín hiệu Mini Converter SDI to HDMI 6G | China | cái | 2 | 1850000

Lãi suất: 12
VAT: 8
```

### 3. Ảnh + caption
Caption nên viết ngắn gọn, ngăn nhau bằng dấu phẩy:
```text
Khách hàng Viễn Thông Đà Nẵng, người nhận Nguyễn Bá Toàn, bộ phận Phòng Kỹ thuật, điện thoại 0912345678, email vantocdn@example.com, lãi 15%, VAT 10%
```

## Flow hỏi bổ sung
Nếu thiếu dữ liệu, bot sẽ hỏi từng bước, ví dụ:
- tên đơn vị / khách hàng
- đơn vị tính
- số lượng
- giá nhập
- lãi suất
- điều khoản giao hàng / thanh toán / bảo hành / hiệu lực
- người ký báo giá

Nếu muốn dừng flow đang làm dở, có thể nhập:
```text
không
thoát
exit
dừng
hủy
cancel
```

## Quy tắc nghiệp vụ đang áp dụng
- Đơn giá bán được làm tròn theo **1.000đ**
- Làm tròn đơn giá **trước**, sau đó mới nhân số lượng
- Nếu không có VAT rõ ràng trong ảnh/caption → mặc định `8%`
- Nếu không có lãi suất rõ ràng trong ảnh/caption → mặc định theo config
- PDF đã gửi sẽ được lưu trong:
```text
output/sent/
```

## Cấu trúc chính
- `server.js`: API tạo PDF
- `telegram-bot.js`: bot Telegram
- `services/config.js`: nạp cấu hình `.env`
- `services/input-router.js`: chọn luồng parser tiết kiệm quota
- `services/ai-input-parser.js`: parser AI unified cho text / ảnh / caption
- `services/telegram-parser.js`: parser thường cho text rõ cấu trúc
- `services/ai-cache.js`: cache kết quả AI để tránh gọi lặp
- `services/quote-data.js`: chuẩn hóa dữ liệu báo giá
- `services/history-store.js`: cấp số báo giá và lưu lịch sử
- `services/render-quote-pdf.js`: render HTML → PDF
- `services/image-preprocess.py`: tiền xử lý ảnh trước khi gửi AI
- `services/pending-store.js`: lưu trạng thái hỏi đáp đang dở
- `templates/bao-gia-ctc.html`: template PDF

## Ghi chú
- `.env` được ignore khỏi git
- `output/` được ignore khỏi git
- lịch sử báo giá lưu ở `data/quote-history.json`
- counter lưu ở `data/counter.json`
- muốn đọc ảnh tốt hơn cần có `python3-pil`, `imagemagick`, `tesseract-ocr`
- sau khi sửa code nên restart PM2:
```bash
pm2 restart ctc-server ctc-telegram-bot --update-env
```
