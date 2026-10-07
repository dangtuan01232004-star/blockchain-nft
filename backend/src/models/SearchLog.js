const mongoose = require("mongoose");

/**
 * Lưu lại mỗi lượt tìm kiếm sản phẩm ở trang mua hàng — phục vụ thống kê
 * từ khoá được tìm nhiều nhất, cải thiện trải nghiệm tìm kiếm sau này.
 * Không gắn với tài khoản cụ thể (người mua không cần đăng nhập), chỉ ghi
 * lại từ khoá + số kết quả trả về + thời điểm tìm kiếm.
 */
const searchLogSchema = new mongoose.Schema(
  {
    query: { type: String, required: true, trim: true },
    resultCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SearchLog", searchLogSchema);
