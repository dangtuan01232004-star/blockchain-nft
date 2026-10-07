const mongoose = require("mongoose");

/**
 * Kết nối MongoDB — dùng để lưu tài khoản người dùng (đăng nhập trang
 * quản trị). KHÔNG dùng để lưu dữ liệu sản phẩm/chuỗi cung ứng — nguồn dữ
 * liệu thật của những thứ đó vẫn là blockchain (xem README mục "Vì sao
 * dùng JSON thay vì database" để hiểu rõ nguyên tắc source-of-truth).
 */
async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn(
      "⚠ Chưa cấu hình MONGODB_URI trong .env — tính năng đăng nhập/đăng ký sẽ không hoạt động " +
      "(các phần khác của hệ thống vẫn chạy bình thường)."
    );
    return;
  }
  try {
    await mongoose.connect(uri);
    console.log("Đã kết nối MongoDB thành công.");
  } catch (err) {
    console.error("Lỗi kết nối MongoDB:", err.message);
  }
}

module.exports = { connectDB };
