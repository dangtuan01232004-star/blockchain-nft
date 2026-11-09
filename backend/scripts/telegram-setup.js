/**
 * Đăng ký webhook Telegram cho bot — chạy 1 lần sau khi deploy backend:
 *   cd backend && node scripts/telegram-setup.js
 *
 * Cần trong .env (hoặc biến môi trường):
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, PUBLIC_BASE_URL (URL Render)
 */
require("dotenv").config();

(async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (!token || !secret || !base.startsWith("https://")) {
    console.error("Cần TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET và PUBLIC_BASE_URL dạng https://...");
    process.exit(1);
  }
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(secret)) {
    console.error("TELEGRAM_WEBHOOK_SECRET chỉ được gồm chữ, số, _ và -, dài 16–256 ký tự.");
    process.exit(1);
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: `${base}/api/telegram/webhook`,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    }),
  });
  console.log(await res.json());
})();
