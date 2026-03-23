---
name: bao-gia-ctc
description: tạo báo giá tự động cho khách hàng từ thông tin người nhận và danh sách hàng hóa. use when the user asks to make a quotation, pricing sheet, báo giá, tính giá bán từ giá nhập, tạo file báo giá pdf, hoặc gửi lại báo giá cho khách qua tin nhắn. this skill is for workflows where the bot must collect customer info, normalize item data, apply a default profit rate, calculate totals, call a local quote-generation service, and return the quotation result clearly.
---

# Mục tiêu

Tạo báo giá chuyên nghiệp cho khách hàng từ dữ liệu đầu vào chuẩn hóa, tính giá bán từ giá nhập theo lãi suất, gọi dịch vụ tạo báo giá/PDF, rồi trả lại kết quả qua tin nhắn.

Skill này dùng cho quy trình báo giá nội bộ CTC, ưu tiên:
- dữ liệu rõ ràng
- không bịa thông tin
- tính toán nhất quán
- phản hồi ngắn gọn, dễ kiểm tra
- có thể mở rộng để gửi file PDF cho khách

# Nguyên tắc vận hành

- Luôn ưu tiên độ chính xác của dữ liệu khách hàng và hàng hóa.
- Không tự suy đoán tên khách hàng, địa chỉ, số điện thoại, email, số lượng, đơn giá.
- Nếu thiếu dữ liệu bắt buộc, phải hỏi lại ngắn gọn trước khi tạo báo giá.
- Nếu người dùng không nêu lãi suất, mặc định dùng `12`.
- Nếu người dùng không nêu địa chỉ, điện thoại, email thì để trống, không tự bịa.
- Mỗi mặt hàng phải được chuẩn hóa thành một object riêng.
- Chỉ tạo báo giá khi đã có tối thiểu:
  - tên người nhận hoặc tên đơn vị
  - ít nhất 1 mặt hàng hợp lệ
- Mỗi mặt hàng hợp lệ phải có tối thiểu:
  - mô tả hàng hóa
  - số lượng
  - đơn giá nhập
- Các trường `quantity`, `costPrice`, `profitRate` phải là số.
- Không chèn diễn giải dài dòng khi người dùng chỉ cần ra báo giá.
- Sau khi có kết quả, trả lời theo dạng xác nhận rõ ràng, dễ đọc.

# Dữ liệu đầu vào cần thu thập

## 1. Thông tin khách hàng
Thu thập các trường sau nếu có:

- `name`: tên khách hàng / tên đơn vị / người nhận
- `address`: địa chỉ
- `phone`: số điện thoại
- `email`: email

Ví dụ:
- Kính gửi: VIỄN THÔNG HUẾ
- Địa chỉ: ...
- Điện thoại: 0912...
- Email: ...

## 2. Danh sách hàng hóa
Mỗi mặt hàng cần đọc được các trường sau:

- `description`: mô tả hàng hóa
- `origin`: xuất xứ
- `unit`: đơn vị tính
- `quantity`: số lượng
- `costPrice`: đơn giá nhập

## 3. Tham số tính giá
- `profitRate`: lãi suất phần trăm
- Mặc định: `12`

# Quy tắc hiểu yêu cầu người dùng

Coi đây là yêu cầu tạo báo giá khi người dùng dùng các cụm như:
- tạo báo giá
- làm báo giá
- báo giá cho khách
- tính giá bán
- lên báo giá
- làm file báo giá
- xuất báo giá pdf
- gửi lại báo giá cho khách

Nếu người dùng gửi dữ liệu tự do, phải tự chuẩn hóa lại trước khi xử lý.

Ví dụ người dùng có thể gửi:

`Tạo báo giá cho Viễn Thông Huế, 2 bộ chuyển đổi Mini Converter SDI to HDMI 6G, giá nhập 1850000, lãi 12%`

hoặc:

`Khách: Viễn Thông Huế
Hàng hóa:
- Mini Converter SDI to HDMI 6G | China | cái | 2 | 1850000`

hoặc gửi danh sách dạng bảng.

# Chuẩn hóa dữ liệu đầu vào

Trước khi gọi dịch vụ tạo báo giá, luôn chuẩn hóa về JSON theo mẫu sau:

```json
{
  "customer": {
    "name": "",
    "address": "",
    "phone": "",
    "email": ""
  },
  "items": [
    {
      "description": "",
      "origin": "",
      "unit": "",
      "quantity": 1,
      "costPrice": 0
    }
  ],
  "profitRate": 12
}
