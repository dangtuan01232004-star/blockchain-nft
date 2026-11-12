const mongoose = require("mongoose");

/**
 * Yêu cầu GỠ hoặc ĐỔI Telegram nhận cảnh báo của một tài khoản.
 *
 * Kẻ chiếm được tài khoản (kể cả có mật khẩu + mã 2FA) muốn cắt kênh cảnh báo
 * để chủ thật không biết gì. Vì vậy thao tác này phải được CHÍNH Telegram đang
 * liên kết bấm "Cho phép" thì mới có hiệu lực — giống duyệt phát hành.
 * Chủ bấm "Không phải tôi" → thiết bị yêu cầu bị đăng xuất ngay.
 */
const telegramChangeSchema = new mongoose.Schema(
  {
    _id: { type: String },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    sessionId: { type: String, required: true },
    action: { type: String, enum: ["unlink", "relink"], required: true },
    ip: { type: String, default: "" },
    status: { type: String, enum: ["pending", "approved", "denied", "used"], default: "pending" },
    decidedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, _id: false }
);
telegramChangeSchema.index({ userId: 1, sessionId: 1, action: 1, createdAt: -1 });
telegramChangeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600 });

module.exports = mongoose.model("TelegramChange", telegramChangeSchema);
