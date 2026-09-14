# 📌 CẤU TRÚC VÀ QUY TẮC DỰ ÁN WEB ĐỌC TRUYỆN (ORCA PLATFORM)

## 1. NGUYÊN TẮC LẬP TRÌNH BẮT BUỘC

- **Mobile-First &amp; Tối giản:** Giao diện tập trung tối ưu cho di động, mượt mà, không giật lag.

- **Tách biệt mô-đun (Modular):** Mỗi file chỉ giữ 1 nhiệm vụ duy nhất (UI / Logic / Config / Service). Sửa file này tuyệt đối không làm ảnh hưởng file khác.

- **Header Ghi chú:** Đặt 3 dòng ghi chú ở đầu mọi file:

  1. // [Nhiệm vụ của file]

  2. // [Đường dẫn file trong dự án]

  3. // [Khi nào cần mở file này ra sửa]

---

## 2. BẢN ĐỒ CẤU TRÚC FILE HỆ THỐNG

Mọi đoạn code sinh ra phải nằm đúng vị trí thư mục sau:

📁 /

├── 📁 config/

│   └── theme.js          # [FILE CHỦ GIAO DIỆN] Đổi màu nền (Light/Dark/Sepia), cỡ chữ, font

├── 📁 components/

│   ├── Header.js         # Thanh tiêu đề top

│   ├── BottomNav.js      # Thanh điều hướng đáy di động (Trang chủ, Tủ sách, Tìm kiếm)

│   ├── StoryCard.js      # Thẻ hiển thị từng bộ truyện

│   ├── ReaderViewer.js   # Khung hiển thị nội dung chương (UI duy nhất)

│   └── ReaderMenu.js     # Bảng điều khiển nổi khi đọc (Đổi font, cỡ chữ, màu nền)

├── 📁 modules/

│   ├── readerLogic.js    # Logic lưu vị trí đang đọc, lưu chương dở (LocalStorage)

│   └── storyLogic.js     # Logic lọc, tìm kiếm, sắp xếp truyện

└── 📁 services/

    └── apiService.js     # Xử lý gọi API / kết nối Database lấy danh sách &amp; nội dung truyện

---

## 3. LỆNH ĐIỀU HÀNH HIỆN TẠI (CURRENT TASK)

Bạn hãy xác nhận đã nắm rõ toàn bộ bản đồ thư mục và quy tắc làm việc trên Orca.

Bây giờ, hãy viết mã nguồn hoàn chỉnh cho file đầu tiên: `config/theme.js`.