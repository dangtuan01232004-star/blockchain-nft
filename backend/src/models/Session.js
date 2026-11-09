const mongoose = require("mongoose");

/**
 * Một phiên đăng nhập (mỗi thiết bị / trình duyệt đăng nhập = 1 phiên).
 * JWT mang `sid` trỏ tới bản ghi này → backend thu hồi được TỪNG phiên,
 * biết phiên nào đang hoạt động ở IP nào, và tự đăng xuất phiên bỏ quên.
 */
const sessionSchema = new mongoose.Schema(
  {
    _id: { type: String }, // sid ngẫu nhiên
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    lastSeenAt: { type: Date, default: Date.now },
    lastSeenIp: { type: String, default: "" },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: "" },
    // Đăng nhập từ IP chưa từng dùng → hiện cảnh báo cho chính chủ trong app
    newIp: { type: Boolean, default: false },
    acknowledged: { type: Boolean, default: false },
    // Đã cảnh báo "dùng song song" cho phiên này chưa (tránh báo lặp)
    concurrentAlerted: { type: Boolean, default: false },
  },
  { timestamps: true, _id: false }
);

// Giữ lịch sử phiên 30 ngày rồi tự xoá
sessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model("Session", sessionSchema);
