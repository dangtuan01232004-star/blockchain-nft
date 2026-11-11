const mongoose = require("mongoose");

/**
 * Thử thách (challenge) passkey dùng ĐÚNG 1 LẦN, hết hạn sau 2 phút.
 * Lấy ra là xoá ngay → không ai dùng lại được một lần đăng nhập cũ (replay).
 */
const webauthnChallengeSchema = new mongoose.Schema(
  {
    _id: { type: String }, // chính là chuỗi challenge
    purpose: { type: String, enum: ["register", "login"], required: true },
    userId: { type: String, default: "" }, // đăng ký / bước 2FA: biết trước tài khoản
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, _id: false }
);

webauthnChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("WebauthnChallenge", webauthnChallengeSchema);
