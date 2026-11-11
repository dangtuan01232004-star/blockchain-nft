/**
 * DANH SÁCH CHẶN IP.
 *  - Tự động chặn IP đang dò mật khẩu / gọi API dồn dập / xin phép mint dồn dập
 *    (AUTO_BLOCK_MINUTES, mặc định 60 phút — ngắn, vì nhiều người có thể dùng chung 1 IP).
 *  - Admin chặn tay từ Nhật ký bảo mật (1 giờ / 24 giờ / 7 ngày), bỏ chặn bất cứ lúc nào.
 *  - IP_ALLOWLIST (Render, phân tách bằng dấu phẩy): KHÔNG BAO GIỜ bị chặn.
 * Lưu MongoDB (sống qua lần khởi động lại) + bộ nhớ đệm để kiểm tra nhanh mỗi request.
 */
const mongoose = require("mongoose");
const BlockedIp = require("../models/BlockedIp");
const { securityEvent } = require("./alerts");

const AUTO_MINUTES = Number(process.env.AUTO_BLOCK_MINUTES || 60);
const REFRESH_MS = 30 * 1000;
let cache = new Map(); // ip -> { until, reason }
let lastLoad = 0;

function allowlist() {
  return new Set(
    String(process.env.IP_ALLOWLIST || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function isValidIp(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || /^[0-9a-f:]{2,39}$/i.test(ip);
}

async function refresh(force = false) {
  if (mongoose.connection.readyState !== 1) return;
  if (!force && Date.now() - lastLoad < REFRESH_MS) return;
  lastLoad = Date.now();
  const list = await BlockedIp.find({ until: { $gte: new Date() } });
  cache = new Map(list.map((b) => [b._id, { until: new Date(b.until), reason: b.reason }]));
}

function blockedEntry(ip) {
  const e = cache.get(ip);
  if (!e) return null;
  if (e.until < new Date()) {
    cache.delete(ip);
    return null;
  }
  return e;
}

/** Middleware: chặn sớm mọi request API từ IP trong danh sách */
function ipBlockMiddleware(req, res, next) {
  refresh().catch(() => {});
  const ip = req.ip || "";
  if (!ip || allowlist().has(ip)) return next();
  const e = blockedEntry(ip);
  if (!e) return next();
  const mins = Math.max(1, Math.ceil((e.until - Date.now()) / 60000));
  return res.status(403).json({
    error: `Địa chỉ IP của bạn đang bị tạm chặn do có dấu hiệu tấn công (còn khoảng ${mins} phút). Nếu bạn là người dùng thật, hãy đổi mạng hoặc liên hệ quản trị viên.`,
    code: "IP_BLOCKED",
  });
}

/**
 * Chặn 1 IP. Trả về false nếu không chặn (IP thuộc danh sách trắng / không hợp lệ).
 * @param {object} o { minutes, reason, auto, by }
 */
async function blockIp(ip, { minutes = AUTO_MINUTES, reason = "", auto = false, by = "" } = {}) {
  ip = String(ip || "").trim();
  if (!ip || !isValidIp(ip) || allowlist().has(ip)) return false;
  if (mongoose.connection.readyState !== 1) return false;
  const until = new Date(Date.now() + minutes * 60 * 1000);
  const existing = await BlockedIp.findById(ip);
  // Chặn tự động không được rút ngắn lệnh chặn dài hơn của admin
  if (existing && new Date(existing.until) > until) return true;
  if (existing) await BlockedIp.updateOne({ _id: ip }, { until, reason, auto, blockedBy: by });
  else await BlockedIp.create({ _id: ip, until, reason, auto, blockedBy: by });
  cache.set(ip, { until, reason });
  await securityEvent({
    type: auto ? "ip_auto_blocked" : "ip_blocked",
    severity: "warning",
    message: `${auto ? "TỰ ĐỘNG chặn" : `Admin ${by} chặn`} IP ${ip} trong ${minutes >= 1440 ? Math.round(minutes / 1440) + " ngày" : minutes >= 60 ? Math.round(minutes / 60) + " giờ" : minutes + " phút"}: ${reason}`,
    ip,
    dedupeKey: auto ? `ipauto:${ip}:${Math.floor(Date.now() / (AUTO_MINUTES * 60 * 1000))}` : undefined,
  });
  return true;
}

async function unblockIp(ip, by = "") {
  await BlockedIp.deleteOne({ _id: ip });
  cache.delete(ip);
  await securityEvent({ type: "ip_unblocked", severity: "info", message: `Admin ${by} bỏ chặn IP ${ip}`, ip });
}

async function listBlocked() {
  await refresh(true);
  return (await BlockedIp.find({ until: { $gte: new Date() } }).sort({ until: -1 })).map((b) => ({
    ip: b._id,
    until: b.until,
    reason: b.reason,
    auto: b.auto,
    blockedBy: b.blockedBy,
    createdAt: b.createdAt,
  }));
}

module.exports = { ipBlockMiddleware, blockIp, unblockIp, listBlocked, isValidIp, AUTO_MINUTES, _cache: () => cache };
