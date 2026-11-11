/**
 * Phát hiện DÒ MẬT KHẨU RẢI (password spraying) — 1 IP thử nhiều tài khoản,
 * mỗi tài khoản chỉ vài lần nên không chạm ngưỡng khoá từng tài khoản.
 *
 * Lưu trong bộ nhớ (đủ cho 1 instance Render). Khởi động lại server thì đếm lại.
 */
const { securityEvent } = require("./alerts");
// nạp muộn để tránh vòng phụ thuộc
const autoBlock = (ip, reason) => require("./ipBlock").blockIp(ip, { auto: true, reason }).catch(() => false);

const WINDOW_MS = 15 * 60 * 1000;
const SPRAY_THRESHOLD = Number(process.env.SPRAY_ACCOUNT_THRESHOLD || 3);
const byIp = new Map(); // ip -> { start, users:Set, alerted }

function windowKey(now = Date.now()) {
  return Math.floor(now / WINDOW_MS);
}

/** Gọi mỗi lần đăng nhập SAI (kể cả username không tồn tại) */
async function trackFailedLogin(ip, username) {
  if (!ip) return;
  const now = Date.now();
  let rec = byIp.get(ip);
  if (!rec || now - rec.start > WINDOW_MS) {
    rec = { start: now, users: new Set(), alerted: false };
    byIp.set(ip, rec);
  }
  rec.users.add(String(username || "").toLowerCase().slice(0, 64));

  // dọn bớt bộ nhớ
  if (byIp.size > 5000) {
    for (const [k, v] of byIp) if (now - v.start > WINDOW_MS) byIp.delete(k);
  }

  if (!rec.alerted && rec.users.size >= SPRAY_THRESHOLD) {
    rec.alerted = true;
    const sample = [...rec.users].slice(0, 5).join(", ");
    await securityEvent({
      type: "login_spray",
      severity: "warning",
      message: `IP ${ip} đang dò nhiều tài khoản: sai đăng nhập ở ${rec.users.size} tài khoản trong 15 phút (${sample})`,
      ip,
      dedupeKey: `spray:${ip}:${windowKey(rec.start)}`,
      meta: { accounts: [...rec.users].slice(0, 20) },
    });
    await autoBlock(ip, `dò mật khẩu nhiều tài khoản (${sample})`);
  }
}

/** Gọi khi bộ giới hạn tốc độ chặn 1 IP ở trang đăng nhập */
async function reportRateLimited(ip, path) {
  await securityEvent({
    type: "login_rate_limited",
    severity: "warning",
    message: `IP ${ip} bị chặn đăng nhập tạm thời vì thử quá nhiều lần (${path}) — có thể đang dò mật khẩu`,
    ip,
    dedupeKey: `ratelimit:${ip}:${windowKey()}`,
  });
  await autoBlock(ip, "thử đăng nhập quá nhiều lần");
}

/** Gọi khi 1 IP vượt giới hạn chung của toàn bộ API (gọi dồn / công cụ quét) */
async function reportApiFlood(ip, path) {
  await securityEvent({
    type: "api_flood",
    severity: "warning",
    message: `IP ${ip} gọi API quá nhiều trong 1 phút (vd. ${String(path).slice(0, 80)}) — có thể là công cụ quét lỗ hổng hoặc tấn công làm quá tải`,
    ip,
    dedupeKey: `apiflood:${ip}:${windowKey()}`,
  });
  await autoBlock(ip, "gọi API dồn dập (quét lỗ hổng / làm quá tải)");
}

module.exports = { trackFailedLogin, reportRateLimited, reportApiFlood, _byIp: byIp };
