const AuditLog = require("../models/AuditLog");

/**
 * Ghi nhật ký bảo mật + gửi cảnh báo cho admin.
 *
 * Kênh cảnh báo: Telegram bot (miễn phí, tức thì trên điện thoại).
 * Cấu hình trong .env / Render Environment:
 *   TELEGRAM_BOT_TOKEN  — tạo bot bằng @BotFather, lấy token
 *   TELEGRAM_CHAT_ID    — nhắn 1 tin cho bot rồi mở
 *                         https://api.telegram.org/bot<TOKEN>/getUpdates để lấy chat.id
 *   ALERT_MIN_SEVERITY  — mức thấp nhất được gửi Telegram (mặc định "warning")
 * Không cấu hình Telegram thì vẫn ghi nhật ký vào MongoDB + in ra log.
 *
 * Không bao giờ làm hỏng request chính nếu ghi log / gửi cảnh báo thất bại.
 */
const LEVEL = { info: 0, warning: 1, critical: 2 };

/**
 * Link mở thẳng mục "Bảo mật & khẩn cấp" trong trang quản trị, gắn vào tin
 * Telegram. Lấy từ ADMIN_PANEL_URL, hoặc suy ra từ FRONTEND_VERIFY_URL.
 */
function adminPanelUrl() {
  if (process.env.ADMIN_PANEL_URL) return process.env.ADMIN_PANEL_URL;
  const v = process.env.FRONTEND_VERIFY_URL || "";
  return v.includes("/verify.html") ? v.replace(/\/verify\.html.*$/, "/admin.html#security") : "";
}
const ICON = { info: "ℹ️", warning: "⚠️", critical: "🚨" };

/**
 * Gửi tin Telegram. Mặc định gửi cho admin (TELEGRAM_CHAT_ID); truyền
 * `chatId` để gửi cho một người dùng cụ thể, `buttons` để kèm nút bấm
 * (ví dụ nút "Không phải tôi").
 */
async function sendTelegram(text, { chatId, buttons } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const target = chatId || process.env.TELEGRAM_CHAT_ID;
  if (!token || !target) return false;
  try {
    const body = { chat_id: target, text, disable_web_page_preview: true };
    if (buttons) body.reply_markup = { inline_keyboard: buttons };
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error("Gửi Telegram thất bại:", res.status, await res.text());
    return res.ok;
  } catch (err) {
    console.error("Gửi Telegram thất bại:", err.message);
    return false;
  }
}

/**
 * @param {object} e
 * @param {string} e.type      mã sự kiện, ví dụ "login_failed", "wallet_changed"
 * @param {"info"|"warning"|"critical"} [e.severity]
 * @param {string} e.message   mô tả cho người đọc
 * @param {object} [e.user]    document User (lấy id/username)
 * @param {string} [e.wallet]
 * @param {string} [e.ip]
 * @param {string} [e.txHash]
 * @param {string} [e.dedupeKey] bỏ qua nếu đã ghi sự kiện cùng khoá
 * @param {object} [e.meta]
 * @returns {Promise<boolean>} false nếu là bản trùng
 */
async function securityEvent(e) {
  const severity = e.severity || "info";
  try {
    await AuditLog.create({
      type: e.type,
      severity,
      message: e.message || "",
      userId: e.user ? e.user._id : null,
      username: e.user ? e.user.username : e.username || "",
      wallet: (e.wallet || "").toLowerCase(),
      ip: e.ip || "",
      txHash: e.txHash || "",
      dedupeKey: e.dedupeKey,
      meta: e.meta || {},
      // Cảnh báo / nghiêm trọng mặc định là "chưa xử lý" → hiện nút xử lý trong admin
      status: severity === "info" ? undefined : "open",
    });
  } catch (err) {
    if (err && err.code === 11000) return false; // đã ghi rồi (trùng dedupeKey)
    console.error("Không ghi được nhật ký bảo mật:", err.message);
  }

  const line = `[${severity.toUpperCase()}] ${e.type}: ${e.message}`;
  if (severity === "critical") console.error(line);
  else console.log(line);

  const min = LEVEL[process.env.ALERT_MIN_SEVERITY] ?? LEVEL.warning;
  if (LEVEL[severity] >= min) {
    const parts = [`${ICON[severity]} ${e.message}`];
    if (e.user) parts.push(`Tài khoản: ${e.user.username}`);
    else if (e.username) parts.push(`Tài khoản: ${e.username}`);
    if (e.wallet) parts.push(`Ví: ${e.wallet}`);
    if (e.ip) parts.push(`IP: ${e.ip}`);
    if (e.txHash) parts.push(`Tx: ${e.txHash}`);
    parts.push(`Loại: ${e.type} · ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`);
    const panel = adminPanelUrl();
    if (panel) parts.push(`Xử lý: ${panel}`);
    await sendTelegram(parts.join("\n"));
  }
  return true;
}

module.exports = { securityEvent, sendTelegram };
