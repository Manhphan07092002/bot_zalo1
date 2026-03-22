# CTC Quote Bot - PDF theo mẫu cố định

Project này tạo **bảng chào giá PDF** theo mẫu cố định của anh.

## Đúng theo yêu cầu
- Giữ nguyên form
- Chỉ thay **tên khách hàng**
- Chỉ thay **nội dung sản phẩm**
- Các điều khoản còn lại giữ nguyên

## Cài đặt
```bash
npm install
```

## Chạy nhanh
```bash
npm run example
```

Hoặc:
```bash
node index.js --input ./data/example.json --output ./output/bao-gia-vthue.pdf
```

## File cần sửa mỗi lần báo giá
Chỉ sửa file `data/example.json`:

```json
{
  "customerName": "VIỄN THÔNG HUẾ",
  "productTitle": "Bộ chuyển đổi tín hiệu Mini Converter SDI to HDMI 6G",
  "productContent": "- Dòng 1\n- Dòng 2\n- Dòng 3",
  "origin": "Singapore",
  "unit": "Bộ",
  "quantity": 1,
  "unitPrice": 5700000,
  "lineTotal": 5700000,
  "subtotal": 5700000,
  "vatPercent": 10,
  "vatAmount": 570000,
  "grandTotal": 6270000
}
```

## File chính
- `templates/bao-gia-ctc.html`: giao diện PDF
- `services/render-quote-pdf.js`: render HTML -> PDF bằng Puppeteer
- `services/quote-data.js`: format tiền, ngày, số tiền bằng chữ
- `index.js`: lệnh chạy chính

## Gợi ý tích hợp bot Zalo / OpenClaw
Khi bot nhận dữ liệu khách hàng:
1. Đổ JSON mới vào file input
2. Gọi `node index.js --input ... --output ...`
3. Lấy file PDF trong thư mục `output/`
4. Gửi lại cho khách qua Zalo

## Nguồn mẫu
Bố cục được dựng theo file báo giá anh gửi: fileciteturn0file0


## Cập nhật mới

- Đã thêm logo CTC ở góc trái đầu trang theo mẫu báo giá.
- Logo nằm tại `assets/ctc-logo.gif` và được nhúng trực tiếp vào HTML khi render PDF.
"# bot_zalo" 
