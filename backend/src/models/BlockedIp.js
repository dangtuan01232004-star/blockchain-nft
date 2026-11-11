const mongoose = require("mongoose");

/** IP bị chặn truy cập API (tự động khi dò/tấn công, hoặc admin chặn tay). Hết hạn tự xoá. */
const blockedIpSchema = new mongoose.Schema(
  {
    _id: { type: String }, // địa chỉ IP
    until: { type: Date, required: true },
    reason: { type: String, default: "" },
    auto: { type: Boolean, default: false },
    blockedBy: { type: String, default: "" },
    hits: { type: Number, default: 0 },
  },
  { timestamps: true, _id: false }
);
blockedIpSchema.index({ until: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("BlockedIp", blockedIpSchema);
