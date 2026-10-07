const mongoose = require("mongoose");

/**
 * Ghi lại mỗi lượt quét/xác thực mã QR của một sản phẩm — dùng để phát
 * hiện dấu hiệu QR bị sao chép (cùng một tokenId nhưng được quét từ quá
 * nhiều thiết bị khác nhau trong thời gian ngắn, trong khi vật lý chỉ có
 * đúng 1 sản phẩm thật mang mã đó).
 *
 * `deviceId` không phải danh tính thật của người dùng — chỉ là một mã
 * ngẫu nhiên do trình duyệt tự sinh và lưu cục bộ (localStorage), dùng để
 * phân biệt "có bao nhiêu thiết bị khác nhau từng quét mã này", không thu
 * thập thông tin cá nhân nào.
 */
const scanLogSchema = new mongoose.Schema(
  {
    tokenId: { type: String, required: true, index: true },
    deviceId: { type: String, required: true },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ScanLog", scanLogSchema);
