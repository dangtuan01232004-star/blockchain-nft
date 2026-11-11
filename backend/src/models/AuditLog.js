const mongoose = require("mongoose");

/**
 * Nhật ký bảo mật — mọi sự kiện nhạy cảm (đăng nhập, sai mật khẩu, đổi ví,
 * duyệt quyền, sự kiện on-chain bất thường do monitor phát hiện...).
 * Admin xem ở mục "Bảo mật" trong admin.html.
 *
 * severity: info | warning | critical
 */
const auditLogSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, index: true },
    severity: { type: String, enum: ["info", "warning", "critical"], default: "info", index: true },
    message: { type: String, default: "" },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    username: { type: String, default: "" },
    wallet: { type: String, default: "" },
    ip: { type: String, default: "" },
    txHash: { type: String, default: "" },
    // Khoá chống trùng (ví dụ "txHash:logIndex" cho sự kiện on-chain)
    dedupeKey: { type: String, default: undefined },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },

    // --- Xử lý sự cố (chỉ áp dụng cho mức cảnh báo / nghiêm trọng) ---
    // open = chưa xử lý · resolved = đã xử lý · false_positive = báo nhầm
    status: { type: String, enum: ["open", "resolved", "false_positive"], default: undefined, index: true },
    resolutionNote: { type: String, default: "" },
    handledBy: { type: String, default: "" },
    handledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ userId: 1, type: 1, createdAt: -1 });
auditLogSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });
// Giữ nhật ký 180 ngày
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

module.exports = mongoose.model("AuditLog", auditLogSchema);
