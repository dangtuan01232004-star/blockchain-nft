const mongoose = require("mongoose");

/**
 * Yêu cầu duyệt phát hành qua Telegram (push MFA) — tạo khi xin phép mint từ
 * THIẾT BỊ / IP LẠ. Chủ tài khoản bấm "Cho phép" hoặc "Từ chối" trên Telegram.
 */
const mintApprovalSchema = new mongoose.Schema(
  {
    _id: { type: String },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    sessionId: { type: String, required: true },
    payloadHash: { type: String, required: true },
    productCode: { type: String, default: "" },
    ip: { type: String, default: "" },
    status: { type: String, enum: ["pending", "approved", "denied", "used"], default: "pending" },
    decidedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, _id: false }
);
mintApprovalSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

module.exports = mongoose.model("MintApproval", mintApprovalSchema);
