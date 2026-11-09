const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const Session = require("../models/Session");
const User = require("../models/User");
const { securityEvent, sendTelegram } = require("./alerts");

/**
 * Quản lý phiên đăng nhập:
 *  - tạo phiên + JWT mang sid
 *  - tự đăng xuất phiên bỏ quên (SESSION_IDLE_MINUTES, mặc định 30 phút)
 *  - giới hạn tuổi tối đa của phiên (JWT_EXPIRES_IN, mặc định 8 giờ)
 *  - phát hiện đăng nhập từ IP mới → báo chính chủ (Telegram + trong app)
 *  - phát hiện 1 tài khoản dùng song song từ 2 IP → cảnh báo
 */
const IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES || 30);
const MAX_HOURS = Number(process.env.SESSION_MAX_HOURS || 8);
const CONCURRENT_WINDOW_MIN = 10;
const MAX_KNOWN_IPS = 20;

function shortUA(ua) {
  const s = String(ua || "");
  const browser = /Edg\//.test(s) ? "Edge" : /Chrome\//.test(s) ? "Chrome" : /Firefox\//.test(s) ? "Firefox" : /Safari\//.test(s) ? "Safari" : "Trình duyệt khác";
  const os = /Windows/.test(s) ? "Windows" : /Android/.test(s) ? "Android" : /iPhone|iPad/.test(s) ? "iOS" : /Mac OS/.test(s) ? "macOS" : /Linux/.test(s) ? "Linux" : "";
  return os ? `${browser} / ${os}` : browser;
}

function fmtTime(d = new Date()) {
  return new Date(d).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

/**
 * Tạo phiên sau khi đã xác thực xong (mật khẩu + 2FA nếu có).
 * @returns {Promise<{token: string, session: object, newIp: boolean}>}
 */
async function startSession(user, req) {
  const ip = req.ip || "";
  const sid = crypto.randomBytes(18).toString("base64url");
  const known = Array.isArray(user.knownIps) ? user.knownIps : [];
  // Lần đăng nhập đầu tiên của tài khoản không tính là "IP lạ"
  const newIp = known.length > 0 && !known.includes(ip);

  const session = await Session.create({
    _id: sid,
    userId: user._id,
    ip,
    lastSeenIp: ip,
    userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
    lastSeenAt: new Date(),
    expiresAt: new Date(Date.now() + MAX_HOURS * 3600 * 1000),
    newIp,
  });

  user.knownIps = [ip, ...known.filter((x) => x !== ip)].slice(0, MAX_KNOWN_IPS);
  await user.save();

  const token = jwt.sign(
    { id: String(user._id), sid, tv: user.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: `${MAX_HOURS}h`, algorithm: "HS256" }
  );

  if (newIp) {
    await notifyNewLogin(user, session);
  }
  return { token, session, newIp };
}

/** Báo cho CHÍNH CHỦ khi tài khoản đăng nhập từ IP mới */
async function notifyNewLogin(user, session) {
  const text =
    `🔐 Tài khoản "${user.username}" vừa đăng nhập từ địa chỉ IP MỚI\n` +
    `IP: ${session.ip}\nThiết bị: ${shortUA(session.userAgent)}\nLúc: ${fmtTime(session.createdAt)}\n\n` +
    `Nếu là bạn, bỏ qua tin này. Nếu KHÔNG phải bạn, bấm nút dưới — tài khoản sẽ bị khoá và đăng xuất khỏi mọi thiết bị ngay.`;
  if (user.telegramChatId) {
    await sendTelegram(text, {
      chatId: user.telegramChatId,
      buttons: [[{ text: "🚫 Không phải tôi — khoá tài khoản", callback_data: `notme:${session._id}` }]],
    });
  }
  await securityEvent({
    type: "login_new_ip",
    severity: user.role === "admin" ? "warning" : "info",
    message: `Đăng nhập từ IP mới (${shortUA(session.userAgent)})${user.telegramChatId ? " — đã báo chủ tài khoản qua Telegram" : ""}`,
    user,
    ip: session.ip,
  });
}

/**
 * Kiểm tra phiên cho mỗi request (gọi từ requireAuth).
 * @returns {Promise<{ok: true, session} | {ok: false, reason: string}>}
 */
async function checkSession(payload, req) {
  if (!payload.sid) return { ok: false, reason: "Phiên cũ không còn được hỗ trợ — vui lòng đăng nhập lại." };
  const session = await Session.findById(payload.sid);
  if (!session || String(session.userId) !== String(payload.id)) {
    return { ok: false, reason: "Phiên đăng nhập không tồn tại." };
  }
  if (session.revokedAt) return { ok: false, reason: "Phiên đăng nhập đã bị thu hồi." };
  const now = Date.now();
  if (new Date(session.expiresAt).getTime() < now) return { ok: false, reason: "Phiên đăng nhập đã hết hạn." };
  if (now - new Date(session.lastSeenAt).getTime() > IDLE_MINUTES * 60 * 1000) {
    await Session.updateOne({ _id: session._id }, { revokedAt: new Date(), revokedReason: "idle" });
    return { ok: false, reason: `Bạn đã không thao tác quá ${IDLE_MINUTES} phút — vui lòng đăng nhập lại.` };
  }

  // Cập nhật "lần cuối dùng" tối đa mỗi 30 giây/lần để đỡ ghi database
  const ip = req.ip || "";
  if (now - new Date(session.lastSeenAt).getTime() > 30 * 1000 || session.lastSeenIp !== ip) {
    await Session.updateOne({ _id: session._id }, { lastSeenAt: new Date(), lastSeenIp: ip });
    session.lastSeenAt = new Date();
    session.lastSeenIp = ip;
    await detectConcurrentUse(session);
  }
  return { ok: true, session };
}

/** Cùng tài khoản, 2 phiên khác IP cùng hoạt động trong 10 phút → cảnh báo */
async function detectConcurrentUse(session) {
  try {
    if (session.concurrentAlerted) return;
    const since = Date.now() - CONCURRENT_WINDOW_MIN * 60 * 1000;
    const others = (await Session.find({ userId: session.userId, revokedAt: null })).filter(
      (s) =>
        s._id !== session._id &&
        new Date(s.lastSeenAt).getTime() >= since &&
        new Date(s.expiresAt).getTime() > Date.now() &&
        (s.lastSeenIp || s.ip) !== session.lastSeenIp
    );
    if (!others.length) return;
    const user = await User.findById(session.userId);
    await Session.updateOne({ _id: session._id }, { concurrentAlerted: true });
    const ips = [session.lastSeenIp, ...others.map((o) => o.lastSeenIp || o.ip)].join(", ");
    await securityEvent({
      type: "concurrent_sessions",
      severity: "warning",
      message: `Tài khoản đang được dùng ĐỒNG THỜI từ ${others.length + 1} địa chỉ IP khác nhau (${ips}) — có thể bị chia sẻ hoặc bị chiếm`,
      user,
      ip: session.lastSeenIp,
    });
    if (user && user.telegramChatId) {
      await sendTelegram(
        `⚠️ Tài khoản "${user.username}" đang được dùng cùng lúc từ nhiều nơi: ${ips}.\nNếu không phải bạn, bấm nút dưới.`,
        {
          chatId: user.telegramChatId,
          buttons: [[{ text: "🚫 Không phải tôi — khoá tài khoản", callback_data: `notme:${others[0]._id}` }]],
        }
      );
    }
  } catch (err) {
    console.error("Không kiểm tra được phiên song song:", err.message);
  }
}

async function revokeSession(sid, reason) {
  await Session.updateOne({ _id: sid, revokedAt: null }, { revokedAt: new Date(), revokedReason: reason });
}

/** Thu hồi mọi phiên của tài khoản (trừ `exceptSid` nếu có) */
async function revokeAllSessions(userId, reason, exceptSid) {
  const list = await Session.find({ userId, revokedAt: null });
  for (const s of list) {
    if (s._id === exceptSid) continue;
    await Session.updateOne({ _id: s._id }, { revokedAt: new Date(), revokedReason: reason });
  }
}

/**
 * "Không phải tôi" — khoá tài khoản, thu hồi mọi phiên, báo động admin.
 * Dùng chung cho nút Telegram và nút trong app.
 */
async function reportNotMe(user, { sessionId, via, ip }) {
  user.disabled = true;
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save();
  await revokeAllSessions(user._id, "not_me");
  let detail = "";
  if (sessionId) {
    const s = await Session.findById(sessionId);
    if (s) detail = ` Phiên bị nghi: IP ${s.ip}, ${shortUA(s.userAgent)}, lúc ${fmtTime(s.createdAt)}.`;
  }
  await securityEvent({
    type: "not_me_reported",
    severity: "critical",
    message:
      `Chủ tài khoản báo "KHÔNG PHẢI TÔI" (qua ${via}) — đã khoá tài khoản và đăng xuất mọi phiên.${detail} ` +
      "Việc cần làm: liên hệ chủ tài khoản, đặt lại mật khẩu, kiểm tra ví liên kết; nếu nghi lộ cả ví → Guardian gắn cờ ví.",
    user,
    ip,
  });
}

module.exports = {
  startSession,
  checkSession,
  revokeSession,
  revokeAllSessions,
  reportNotMe,
  shortUA,
  IDLE_MINUTES,
};
