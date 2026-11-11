const express = require("express");
const crypto = require("crypto");
const User = require("../models/User");
const Session = require("../models/Session");
const { reportNotMe } = require("../services/sessions");
const { securityEvent } = require("../services/alerts");

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

    // 2. Nút "Không phải tôi"
    const cb = update.callback_query;
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
