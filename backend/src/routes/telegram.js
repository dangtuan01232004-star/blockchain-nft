const express = require("express");
const crypto = require("crypto");
const User = require("../models/User");
const Session = require("../models/Session");
const { reportNotMe } = require("../services/sessions");
const { securityEvent } = require("../services/alerts");
const MintApproval = require("../models/MintApproval");
const TelegramChange = require("../models/TelegramChange");
const { revokeSession } = require("../services/sessions");

/**
 * Webhook Telegram — Telegram gọi vào đây khi:
 *  - người dùng bấm Start với mã liên kết  → gắn chat vào tài khoản
 *  - người dùng bấm nút "Không phải tôi"    → khoá tài khoản ngay
 *
 * Bảo vệ: Telegram gửi kèm header X-Telegram-Bot-Api-Secret-Token đúng
 * bằng TELEGRAM_WEBHOOK_SECRET đã đăng ký (scripts/telegram-setup.js).
 * Request không có header đúng bị từ chối → không ai giả mạo được nút bấm.
 */
const router = express.Router();

async function tg(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`Telegram ${method} lỗi:`, err.message);
  }
}

function secretOk(req) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET || "";
  const got = String(req.headers["x-telegram-bot-api-secret-token"] || "");
  if (!expected || got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

router.post("/webhook", async (req, res) => {
  if (!secretOk(req)) return res.status(401).json({ error: "unauthorized" });
  // Trả 200 ngay cho Telegram, xử lý tiếp phía sau
  res.json({ ok: true });

  try {
    const update = req.body || {};

    // 1. Liên kết: "/start <mã>"
    const msg = update.message;
    if (msg && typeof msg.text === "string" && msg.text.startsWith("/start")) {
      const chatId = String(msg.chat && msg.chat.id);
      const code = msg.text.split(/\s+/)[1] || "";
      const user = code ? await User.findOne({ telegramLinkCode: code }) : null;
      if (!user || !user.telegramLinkExpires || user.telegramLinkExpires < new Date()) {
        await tg("sendMessage", {
          chat_id: chatId,
          text: "Mã liên kết không hợp lệ hoặc đã hết hạn. Vào trang quản trị → Tài khoản của tôi → Liên kết Telegram để lấy mã mới.",
        });
        return;
      }
      const oldChat = user.telegramChatId || "";
      const linkSession = user.telegramLinkSession || "";
      user.telegramChatId = chatId;
      user.telegramLinkCode = "";
      user.telegramLinkExpires = null;
      if (oldChat && oldChat !== chatId) {
        user.telegramPrevChatId = oldChat;
        user.telegramPrevUntil = new Date(Date.now() + 24 * 3600 * 1000);
      }
      await user.save();
      if (oldChat && oldChat !== chatId) {
        // Báo về Telegram CŨ — chủ thật vẫn còn nút khoá dù cảnh báo đã bị chuyển đi
        await tg("sendMessage", {
          chat_id: oldChat,
          text:
            `⚠️ Cảnh báo của tài khoản "${user.username}" vừa được CHUYỂN sang một Telegram khác.\n` +
            "Từ giờ Telegram này sẽ không nhận cảnh báo nữa.\n\nNếu KHÔNG phải bạn, bấm nút dưới để khoá tài khoản ngay (còn hiệu lực 24 giờ).",
          reply_markup: linkSession
            ? { inline_keyboard: [[{ text: "🚫 Không phải tôi — khoá tài khoản", callback_data: `notme:${linkSession}` }]] }
            : undefined,
        });
        await securityEvent({
          type: "telegram_relinked",
          severity: "warning",
          message: "Đổi Telegram nhận cảnh báo sang tài khoản Telegram KHÁC (đã báo về Telegram cũ)",
          user,
        });
      } else {
        await securityEvent({ type: "telegram_linked", severity: "info", message: "Liên kết Telegram nhận cảnh báo đăng nhập", user });
      }
      await tg("sendMessage", {
        chat_id: chatId,
        text: `✅ Đã liên kết với tài khoản "${user.username}". Bạn sẽ nhận tin khi tài khoản đăng nhập từ nơi lạ, kèm nút "Không phải tôi" để khoá tài khoản ngay.`,
      });
      return;
    }

    const cb = update.callback_query;

    // 3. Duyệt phát hành từ thiết bị lạ: "Cho phép" / "Từ chối"
    if (cb && typeof cb.data === "string" && /^mint(ok|no):/.test(cb.data)) {
      const approve = cb.data.startsWith("mintok:");
      const id = cb.data.slice(7);
      const chatId = String((cb.message && cb.message.chat && cb.message.chat.id) || (cb.from && cb.from.id));
      const ap = await MintApproval.findById(id);
      const user = ap ? await User.findById(ap.userId) : null;
      if (!user || user.telegramChatId !== chatId) {
        await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Không xác minh được tài khoản.", show_alert: true });
        return;
      }
      if (ap.status !== "pending" || new Date(ap.expiresAt) < new Date()) {
        await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Yêu cầu đã được xử lý hoặc đã hết hạn.", show_alert: true });
        return;
      }
      await MintApproval.updateOne({ _id: id, status: "pending" }, { status: approve ? "approved" : "denied", decidedAt: new Date() });
      if (approve) {
        await securityEvent({
          type: "mint_approved_telegram",
          severity: "info",
          message: `Chủ tài khoản CHO PHÉP phát hành ${ap.productCode} qua Telegram`,
          user,
          ip: ap.ip,
        });
        await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Đã cho phép phát hành." });
        await tg("sendMessage", { chat_id: chatId, text: `✅ Đã cho phép phát hành ${ap.productCode}.` });
      } else {
        await revokeSession(ap.sessionId, "telegram_denied").catch(() => {});
        await securityEvent({
          type: "mint_denied_telegram",
          severity: "critical",
          message:
            `Chủ tài khoản TỪ CHỐI yêu cầu phát hành ${ap.productCode} từ IP ${ap.ip} trên Telegram — đã đăng xuất thiết bị đó. ` +
            "Nghi tài khoản + ví nhà sản xuất bị chiếm: cân nhắc khoá tài khoản và gắn cờ ví.",
          user,
          ip: ap.ip,
        });
        await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Đã từ chối và đăng xuất thiết bị đó." });
        await tg("sendMessage", {
          chat_id: chatId,
          text:
            `🚫 Đã TỪ CHỐI phát hành ${ap.productCode} và đăng xuất thiết bị lạ (IP ${ap.ip}). Quản trị viên đã được báo.\n` +
            "Nên đổi mật khẩu ngay. Nếu nghi lộ cả ví MetaMask, báo quản trị viên để khoá ví trên blockchain.",
          reply_markup: { inline_keyboard: [[{ text: "🔒 Khoá luôn tài khoản", callback_data: `notme:${ap.sessionId}` }]] },
        });
      }
      return;
    }

    // 4. Duyệt GỠ / ĐỔI Telegram: chỉ chính Telegram đang liên kết mới bấm được
    if (cb && typeof cb.data === "string" && /^tg(ok|no):/.test(cb.data)) {
      const approve = cb.data.startsWith("tgok:");
      const id = cb.data.slice(5);
      const chatId = String((cb.message && cb.message.chat && cb.message.chat.id) || (cb.from && cb.from.id));
      const rq = await TelegramChange.findById(id);
      const user = rq ? await User.findById(rq.userId) : null;
      if (!user || user.telegramChatId !== chatId) {
        await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Không xác minh được tài khoản.", show_alert: true });
        return;
      }
      if (rq.status !== "pending" || new Date(rq.expiresAt) < new Date()) {
        await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Yêu cầu đã được xử lý hoặc đã hết hạn.", show_alert: true });
        return;
      }
      const what = rq.action === "unlink" ? "gỡ liên kết Telegram" : "đổi sang Telegram khác";
      await TelegramChange.updateOne({ _id: id, status: "pending" }, { status: approve ? "approved" : "denied", decidedAt: new Date() });
      if (approve) {
        await securityEvent({
          type: "telegram_change_approved",
          severity: "info",
          message: `Chủ tài khoản CHO PHÉP ${what} qua Telegram`,
          user,
          ip: rq.ip,
        });
        await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Đã cho phép." });
        await tg("sendMessage", { chat_id: chatId, text: `✅ Đã cho phép ${what}. Quay lại trang web để hoàn tất.` });
      } else {
        await revokeSession(rq.sessionId, "telegram_change_denied").catch(() => {});
        await securityEvent({
          type: "telegram_change_denied",
          severity: "critical",
          message:
            `Chủ tài khoản TỪ CHỐI yêu cầu ${what} từ IP ${rq.ip} — đã đăng xuất thiết bị đó. ` +
            "Kẻ lạ đã qua được mật khẩu + 2FA: cân nhắc khoá tài khoản.",
          user,
          ip: rq.ip,
        });
        await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Đã từ chối và đăng xuất thiết bị đó." });
        await tg("sendMessage", {
          chat_id: chatId,
          text:
            `🚫 Đã CHẶN yêu cầu ${what} và đăng xuất thiết bị lạ (IP ${rq.ip}). Telegram này VẪN đang nhận cảnh báo.\n` +
            "Kẻ đó đã biết mật khẩu và mã 2FA — nên đổi mật khẩu và đặt lại 2FA ngay.",
          reply_markup: { inline_keyboard: [[{ text: "🔒 Khoá luôn tài khoản", callback_data: `notme:${rq.sessionId}` }]] },
        });
      }
      return;
    }

    // 2. Nút "Không phải tôi"
    if (cb && typeof cb.data === "string" && cb.data.startsWith("notme:")) {
      const sid = cb.data.slice("notme:".length);
      const chatId = String((cb.message && cb.message.chat && cb.message.chat.id) || (cb.from && cb.from.id));
      const session = await Session.findById(sid);
      const user = session ? await User.findById(session.userId) : null;
      // Chỉ chính chat đã liên kết với tài khoản đó mới được bấm
      const isCurrent = user && user.telegramChatId && user.telegramChatId === chatId;
      const isPrevious =
        user && user.telegramPrevChatId === chatId && user.telegramPrevUntil && new Date(user.telegramPrevUntil) > new Date();
      if (!isCurrent && !isPrevious) {
        await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Không xác minh được tài khoản.", show_alert: true });
        return;
      }
      if (!user.disabled) {
        await reportNotMe(user, { sessionId: sid, via: "Telegram" });
      }
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Đã khoá tài khoản." });
      await tg("sendMessage", {
        chat_id: chatId,
        text:
          "🔒 Đã KHOÁ tài khoản và đăng xuất khỏi mọi thiết bị. Quản trị viên đã được báo.\n" +
          "Liên hệ quản trị viên để xác minh danh tính, đặt lại mật khẩu và mở khoá. " +
          "Nếu bạn nghi lộ cả ví MetaMask, báo ngay để khoá ví trên blockchain.",
      });
    }
  } catch (err) {
    console.error("Lỗi xử lý webhook Telegram:", err);
  }
});

module.exports = router;
