const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { ethers } = require("ethers");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { securityEvent } = require("../services/alerts");
const { getReadOnlyContract } = require("../services/blockchain");
const Session = require("../models/Session");
const {
  startSession,
  revokeSession,
  revokeAllSessions,
  reportNotMe,
  shortUA,
  IDLE_MINUTES,
} = require("../services/sessions");
const {
  encrypt,
  decrypt,
  generateTotpSecret,
  verifyTotp,
  totpUri,
  generateBackupCodes,
  hashBackupCode,
} = require("../services/crypto");
const QRCode = require("qrcode");
const WebauthnChallenge = require("../models/WebauthnChallenge");
const webauthn = require("../services/webauthn");
const { sendTelegram } = require("../services/alerts");
const { trackFailedLogin } = require("../services/loginGuard");
const loginLockout = require("../services/loginLockout");
const TelegramChange = require("../models/TelegramChange");
const ipBlock = require("../services/ipBlock");
const authCookie = require("../services/authCookie");
const { asId } = require("../services/queryGuard");

const router = express.Router();

const MAX_FAILED_LOGINS = Number(process.env.MAX_FAILED_LOGINS || 5);
const LOCK_MINUTES = Number(process.env.LOGIN_LOCK_MINUTES || 15);
const NONCE_TTL_MS = 5 * 60 * 1000;

// Không bao giờ trả các trường này ra ngoài
const PRIVATE_FIELDS =
  "-passwordHash -walletNonce -walletNonceFor -walletNonceExpires -tokenVersion -knownIps " +
  "-twoFactorSecret -twoFactorPendingSecret -twoFactorLastStep -backupCodeHashes " +
  "-telegramChatId -telegramLinkCode -telegramLinkExpires -passkeys";

// Vai trò tài khoản → vai trò on-chain cần có trước khi được coi là "đã duyệt"
const USER_ROLE_TO_CONTRACT_ROLE = { manufacturer: "MANUFACTURER_ROLE", distributor: "DISTRIBUTOR_ROLE" };

// Băm giả để so sánh khi username không tồn tại — giữ thời gian phản hồi
// như nhau, không lộ "username này có tồn tại hay không"
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", 10);

/** Token tạm (5 phút) giữa bước mật khẩu và bước nhập mã 2FA — không dùng để gọi API */
function signMfaToken(user) {
  return jwt.sign({ id: String(user._id), typ: "mfa", tv: user.tokenVersion || 0 }, process.env.JWT_SECRET, {
    expiresIn: "5m",
    algorithm: "HS256",
  });
}

function publicUser(user) {
  return {
    id: user._id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    twoFactorEnabled: Boolean(user.twoFactorEnabled),
  };
}

/** Gửi tin Telegram riêng cho CHÍNH CHỦ tài khoản (nếu đã liên kết) */
async function notifyOwner(user, text, buttons) {
  if (!user.telegramChatId) return false;
  try {
    await sendTelegram(text, { chatId: user.telegramChatId, buttons });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ghi nhận sai mật khẩu / sai mã 2FA. KHÔNG khoá tài khoản (để chính chủ ở
 * thiết bị khác vẫn vào được) — thay vào đó chặn IP có leo thang qua
 * services/loginLockout.js, và cảnh báo chủ tài khoản qua Telegram.
 */
async function registerFailure(user, req, what) {
  const isMfa = what === "mã 2FA";

  // Đúng mật khẩu nhưng sai 2FA = mật khẩu đã lộ → cảnh báo chủ ngay từ lần đầu
  if (isMfa) {
    const fresh = await securityEvent({
      type: "mfa_failed_password_ok",
      severity: "warning",
      message: "ĐÚNG mật khẩu nhưng SAI mã xác thực 2 lớp — mật khẩu của tài khoản này có thể đã bị lộ",
      user,
      ip: req.ip,
      dedupeKey: `mfafail:${user._id}:${Math.floor(Date.now() / (15 * 60 * 1000))}`,
    });
    if (fresh) {
      await notifyOwner(
        user,
        `⚠️ Có người vừa nhập ĐÚNG mật khẩu tài khoản "${user.username}" nhưng bị chặn ở bước xác thực 2 lớp.\n` +
          `IP: ${req.ip}\n\n` +
          "Nếu không phải bạn: bấm nút dưới để chặn IP này, rồi ĐỔI MẬT KHẨU NGAY.",
        [[{ text: "🚫 Không phải tôi — chặn IP này", callback_data: `ipno:${req.ip}` }]]
      );
    }
  }

  // Chặn IP có leo thang (15 phút → 1 giờ → 24 giờ → vĩnh viễn). Tài khoản KHÔNG bị khoá.
  const r = await loginLockout.recordFailure(req.ip, user.username);
  if (r.distributed) {
    await securityEvent({
      type: "login_distributed",
      severity: "critical",
      message: `Tài khoản "${user.username}" đang bị dò mật khẩu PHÂN TÁN từ nhiều IP khác nhau (đổi IP để né chặn). Tài khoản không bị khoá để tránh gián đoạn chính chủ — nên đổi mật khẩu mạnh và bật 2FA/passkey.`,
      user,
      ip: req.ip,
      dedupeKey: `distrib:${user._id}:${Math.floor(Date.now() / (15 * 60 * 1000))}`,
    });
    await notifyOwner(
      user,
      `🚨 Tài khoản "${user.username}" đang bị dò mật khẩu từ NHIỀU máy khác nhau.\n\n` +
        "Tài khoản của bạn vẫn đăng nhập được bình thường. Hãy đổi mật khẩu mạnh và bật xác thực 2 lớp / passkey ngay."
    );
  }
  if (r.blocked) {
    await notifyOwner(
      user,
      `🔒 IP ${req.ip} vừa bị CHẶN ${r.label} vì nhập sai ${what} nhiều lần vào tài khoản "${user.username}".\n\n` +
        (isMfa
          ? "Người này đã nhập ĐÚNG mật khẩu của bạn → mật khẩu đã bị lộ. Hãy đổi mật khẩu ngay."
          : "Tài khoản của bạn KHÔNG bị khoá — bạn vẫn đăng nhập được từ thiết bị/mạng khác.")
    );
    await securityEvent({
      type: r.permanent ? "ip_blocked_permanent" : "account_bruteforce_blocked",
      severity: user.role === "admin" || isMfa || r.permanent ? "critical" : "warning",
      message:
        `IP ${req.ip} bị chặn ${r.label} sau nhiều lần sai ${what} vào "${user.username}" — ` +
        "tài khoản KHÔNG bị khoá, chính chủ ở thiết bị khác vẫn đăng nhập được" +
        (r.permanent ? " (ĐÃ CHẶN VĨNH VIỄN — vào Bảo mật & khẩn cấp để bỏ chặn nếu nhầm)" : ""),
      user,
      ip: req.ip,
    });
    return;
  }
  if (!isMfa) {
    await securityEvent({
      type: "login_failed",
      severity: "info",
      message: `Sai ${what} (còn ${r.remaining} lần trước khi IP bị chặn)`,
      user,
      ip: req.ip,
    });
  } else {
    await securityEvent({ type: "mfa_failed", severity: "info", message: "Sai mã 2FA", user, ip: req.ip });
  }
}

/** Hoàn tất đăng nhập: tạo phiên, báo IP mới, trả token */
async function completeLogin(user, req, res) {
  user.failedLogins = 0;
  user.lockUntil = null;
  loginLockout.clearFailures(req.ip, user.username);
  user.lastLoginAt = new Date();
  user.lastLoginIp = req.ip || "";
  // IP mới được startSession() ghi riêng (mức Cảnh báo, báo admin) → ở đây chỉ ghi thông tin
  const { token, session } = await startSession(user, req);
  await securityEvent({ type: "login", severity: "info", message: "Đăng nhập thành công", user, ip: req.ip });
  authCookie.sendLogin(req, res, { token, session, user: publicUser(user) });
}

function lockedResponse(user, res) {
  const mins = Math.ceil((user.lockUntil - Date.now()) / 60000);
  return res.status(423).json({ error: `Tài khoản tạm khoá do nhập sai nhiều lần. Thử lại sau ${mins} phút.` });
}

/** Tin nhắn người dùng ký trong MetaMask để chứng minh mình sở hữu ví (kiểu SIWE / EIP-4361) */
function buildWalletLinkMessage({ origin, username, address, nonce, expiresAt }) {
  return [
    `${origin || "NFTTrace"} yêu cầu bạn ký để LIÊN KẾT VÍ với tài khoản quản trị.`,
    "",
    `Tài khoản: ${username}`,
    `Ví: ${address}`,
    `Nonce: ${nonce}`,
    `Hết hạn: ${expiresAt.toISOString()}`,
    "",
    "Ký tin nhắn này KHÔNG tốn phí gas và KHÔNG cho phép chuyển tài sản của bạn.",
  ].join("\n");
}

/**
 * POST /api/auth/register
 * body: { username, password, displayName, role }
 *
 * Đăng ký công khai chỉ tạo tài khoản manufacturer/distributor. Admin đầu
 * tiên phải đổi role thành "admin" trực tiếp trong MongoDB Atlas.
 * Ví KHÔNG được nhận lúc đăng ký — phải liên kết sau bằng chữ ký.
 */
router.post("/register", async (req, res) => {
  try {
    const { username, password, displayName, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Thiếu username hoặc password" });
    }
    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "Mật khẩu phải có ít nhất 8 ký tự" });
    }
    if (role === "admin") {
      return res.status(403).json({ error: "Không thể tự đăng ký tài khoản admin" });
    }
    if (!["manufacturer", "distributor"].includes(role)) {
      return res.status(400).json({ error: "Vai trò đăng ký không hợp lệ" });
    }

    const existing = await User.findOne({ username: String(username).toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: "Username đã tồn tại" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      username,
      passwordHash,
      displayName: displayName || username,
      role,
    });

    await securityEvent({
      type: "register",
      severity: "info",
      message: `Tài khoản mới đăng ký (${role})`,
      user,
      ip: req.ip,
    });

    const { token, session } = await startSession(user, req);
    authCookie.sendLogin(req, res, { token, session, user: publicUser(user), status: 201 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi khi đăng ký" });
  }
});

/** POST /api/auth/login — body: { username, password } */
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Thiếu username hoặc password" });
    }

    const user = await User.findOne({ username: String(username).toLowerCase() });
    if (!user) {
      await bcrypt.compare(String(password), DUMMY_HASH);
      await trackFailedLogin(req.ip, username);
      return res.status(401).json({ error: "Sai username hoặc mật khẩu" });
    }


    const ok = await bcrypt.compare(String(password), user.passwordHash);
    if (!ok) {
      await trackFailedLogin(req.ip, username);
      await registerFailure(user, req, "mật khẩu");
      return res.status(401).json({ error: "Sai username hoặc mật khẩu" });
    }

    if (user.disabled) {
      await securityEvent({
        type: "login_disabled_account",
        severity: "warning",
        message: "Có người đăng nhập ĐÚNG mật khẩu vào tài khoản đã bị khoá",
        user,
        ip: req.ip,
      });
      return res.status(403).json({ error: "Tài khoản đã bị khoá. Liên hệ quản trị viên." });
    }

    // Bật 2FA → chưa cấp phiên, chỉ trả token tạm để làm bước 2
    // Có mã 6 số HOẶC có passkey → mật khẩu thôi là chưa đủ, phải qua bước 2
    const hasPasskey = (user.passkeys || []).length > 0;
    if (user.twoFactorEnabled || hasPasskey) {
      const methods = [];
      if (hasPasskey) methods.push("passkey");
      if (user.twoFactorEnabled) methods.push("totp");
      return res.json({ twoFactorRequired: true, mfaToken: signMfaToken(user), methods });
    }
    await completeLogin(user, req, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi khi đăng nhập" });
  }
});

/**
 * POST /api/auth/login/2fa — bước 2 khi tài khoản bật xác thực 2 lớp.
 * body: { mfaToken, code }  — code là 6 số từ app Authenticator,
 * hoặc mã dự phòng dạng ABCD-EFGH (mỗi mã dùng 1 lần).
 */
router.post("/login/2fa", async (req, res) => {
  try {
    const { mfaToken, code } = req.body || {};
    let payload;
    try {
      payload = jwt.verify(String(mfaToken || ""), process.env.JWT_SECRET, { algorithms: ["HS256"] });
      if (payload.typ !== "mfa") throw new Error("sai loại token");
    } catch {
      return res.status(401).json({ error: "Phiên xác thực đã hết hạn — vui lòng đăng nhập lại." });
    }
    const user = await User.findById(payload.id);
    if (!user || user.disabled || !user.twoFactorEnabled || (payload.tv ?? 0) !== (user.tokenVersion ?? 0)) {
      return res.status(401).json({ error: "Không thể xác thực — vui lòng đăng nhập lại." });
    }

    const input = String(code || "").trim();
    let passed = false;
    if (/^\d{6}$/.test(input.replace(/\s/g, ""))) {
      const step = verifyTotp(decrypt(user.twoFactorSecret), input, user.twoFactorLastStep ?? -1);
      if (step !== null) {
        user.twoFactorLastStep = step;
        passed = true;
      }
    } else if (input) {
      const h = hashBackupCode(input);
      if ((user.backupCodeHashes || []).includes(h)) {
        user.backupCodeHashes = user.backupCodeHashes.filter((x) => x !== h);
        passed = true;
        await securityEvent({
          type: "mfa_backup_code_used",
          severity: "warning",
          message: `Đăng nhập bằng MÃ DỰ PHÒNG 2FA (còn ${user.backupCodeHashes.length} mã)`,
          user,
          ip: req.ip,
        });
      }
    }
    if (!passed) {
      await registerFailure(user, req, "mã 2FA");
      return res.status(401).json({ error: "Mã xác thực không đúng" });
    }
    await completeLogin(user, req, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi khi xác thực 2 lớp" });
  }
});

/**
 * GET /api/auth/session-check — trang web hỏi định kỳ "phiên của tôi còn hiệu lực?".
 * Admin bấm "Đăng xuất mọi phiên" / khoá tài khoản → các tab đang mở tự thoát
 * trong vài giây thay vì vẫn hiện giao diện cũ. Gửi kèm header
 * X-Background-Check: 1 để KHÔNG gia hạn thời gian chờ của phiên.
 */
router.get("/session-check", requireAuth, (req, res) => {
  res.json({ ok: true });
});

/** GET /api/auth/me — kiểm tra token còn hợp lệ không, trả lại thông tin user */
router.get("/me", requireAuth, async (req, res) => {
  const full = await User.findById(req.user.id);
  if (!full) return res.status(404).json({ error: "Không tìm thấy tài khoản" });
  const user = await User.findById(req.user.id).select(PRIVATE_FIELDS);
  const out = typeof user.toJSON === "function" ? user.toJSON() : { ...user };
  out.telegramLinked = Boolean(full.telegramChatId);
  out.backupCodesLeft = (full.backupCodeHashes || []).length;
  out.passkeyCount = (full.passkeys || []).length;
  out.sessionId = req.authSession._id;
  res.json(out);
});

// ---------------------------------------------------------------------
// Phiên đăng nhập của chính mình
// ---------------------------------------------------------------------

function sessionView(s, currentSid) {
  const now = Date.now();
  let state = "active";
  if (s.revokedAt) state = s.revokedReason === "idle" ? "idle" : "revoked";
  else if (new Date(s.expiresAt).getTime() < now) state = "expired";
  // Bỏ quên quá thời gian chờ → token đã vô dụng, không hiện là "đang đăng nhập"
  else if (now - new Date(s.lastSeenAt).getTime() > IDLE_MINUTES * 60 * 1000) state = "idle";
  return {
    id: s._id,
    current: s._id === currentSid,
    ip: s.ip,
    lastSeenIp: s.lastSeenIp || s.ip,
    device: shortUA(s.userAgent),
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    newIp: Boolean(s.newIp),
    state,
    revokedReason: s.revokedReason || "",
  };
}

/** GET /api/auth/me/sessions — phiên đang hoạt động + 20 lần đăng nhập gần nhất */
router.get("/me/sessions", requireAuth, async (req, res) => {
  const all = (await Session.find({ userId: req.dbUser._id })).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  const views = all.map((s) => sessionView(s, req.authSession._id));
  res.json({ active: views.filter((v) => v.state === "active"), history: views.slice(0, 20) });
});

/** DELETE /api/auth/me/sessions/:sid — đăng xuất 1 thiết bị */
router.delete("/me/sessions/:sid", requireAuth, async (req, res) => {
  const s = await Session.findById(req.params.sid);
  if (!s || String(s.userId) !== String(req.dbUser._id)) return res.status(404).json({ error: "Không tìm thấy phiên" });
  await revokeSession(s._id, "user_revoked");
  res.json({ ok: true });
});

/**
 * Kiểm tra trình duyệt có nhận cookie HttpOnly bên thứ ba (phân vùng) không:
 * POST /cookie-check đặt cookie thử, GET /cookie-check xem nó có quay lại không.
 * Không nhận → frontend dùng chế độ dự phòng (Bearer trong sessionStorage).
 */
router.post("/cookie-check", (req, res) => {
  authCookie.appendSetCookie(res, `${authCookie.TEST_COOKIE}=1; ${authCookie.cookieAttrs(req, 120)}`);
  res.json({ ok: true });
});
router.get("/cookie-check", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ cookies: authCookie.readCookie(req, authCookie.TEST_COOKIE) === "1" });
});

/** GET /api/auth/csrf — mã CSRF của phiên hiện tại (trang lạ không đọc được nhờ CORS) */
router.get("/csrf", requireAuth, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ csrfToken: req.authVia === "cookie" ? authCookie.csrfFor(req.authSession._id) : null, authMode: req.authVia });
});

/** POST /api/auth/me/logout — đăng xuất phiên hiện tại */
router.post("/me/logout", requireAuth, async (req, res) => {
  await revokeSession(req.authSession._id, "logout");
  authCookie.clearAuthCookie(req, res);
  res.json({ ok: true });
});

/** POST /api/auth/me/logout-all — đăng xuất khỏi mọi thiết bị (kể cả thiết bị này) */
router.post("/me/logout-all", requireAuth, async (req, res) => {
  await User.updateOne({ _id: req.user.id }, { $inc: { tokenVersion: 1 } });
  await revokeAllSessions(req.dbUser._id, "logout_all");
  await securityEvent({ type: "logout_all", severity: "info", message: "Tự đăng xuất mọi phiên", user: req.dbUser, ip: req.ip });
  authCookie.clearAuthCookie(req, res);
  res.json({ ok: true });
});

/**
 * GET /api/auth/me/security-notices — các lần đăng nhập từ IP MỚI mà chủ
 * tài khoản chưa xác nhận. Trang admin hiện thành banner cảnh báo.
 */
router.get("/me/security-notices", requireAuth, async (req, res) => {
  const list = (await Session.find({ userId: req.dbUser._id, newIp: true, acknowledged: false }))
    .filter((s) => s._id !== req.authSession._id)
    .map((s) => sessionView(s, req.authSession._id));
  res.json(list);
});

/** POST /api/auth/me/security-notices/ack — "Đúng là tôi" */
router.post("/me/security-notices/ack", requireAuth, async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 50) : [];
  for (const raw of ids) {
    const id = asId(raw); // chặn {"$ne": ""} lọt vào điều kiện truy vấn
    if (!id) continue;
    const s = await Session.findById(id);
    if (s && String(s.userId) === String(req.dbUser._id)) await Session.updateOne({ _id: id }, { acknowledged: true });
  }
  res.json({ ok: true });
});

/**
 * POST /api/auth/me/not-me — "Không phải tôi" bấm TRONG APP (chủ tài khoản
 * đang đăng nhập hợp lệ ở thiết bị này). Đăng xuất mọi thiết bị KHÁC, báo
 * động admin, và yêu cầu đổi mật khẩu ngay.
 * body: { sessionId } — phiên lạ bị nghi
 */
router.post("/me/not-me", requireAuth, async (req, res) => {
  const sid = asId(req.body && req.body.sessionId);
  let detail = "";
  if (sid) {
    const s = await Session.findById(sid);
    if (s && String(s.userId) === String(req.dbUser._id)) {
      detail = ` Phiên bị nghi: IP ${s.ip}, ${shortUA(s.userAgent)}.`;
      await Session.updateOne({ _id: sid }, { acknowledged: true });
    }
  }
  await revokeAllSessions(req.dbUser._id, "not_me", req.authSession._id);
  await securityEvent({
    type: "not_me_reported",
    severity: "critical",
    message: `Chủ tài khoản báo "KHÔNG PHẢI TÔI" trong app — đã đăng xuất mọi thiết bị khác, yêu cầu đổi mật khẩu.${detail}`,
    user: req.dbUser,
    ip: req.ip,
  });
  res.json({ ok: true, mustChangePassword: true });
});

/**
 * POST /api/auth/me/password — đổi mật khẩu.
 * body: { currentPassword, newPassword, code? } (code bắt buộc nếu bật 2FA)
 * Đổi xong: mọi phiên cũ bị đăng xuất, trả token mới cho thiết bị này.
 */
router.post("/me/password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword, code } = req.body || {};
    const user = await User.findById(req.dbUser._id);
    if (!(await bcrypt.compare(String(currentPassword || ""), user.passwordHash))) {
      await registerFailure(user, req, "mật khẩu");
      return res.status(401).json({ error: "Mật khẩu hiện tại không đúng" });
    }
    if (typeof newPassword !== "string" || newPassword.length < 8) {
      return res.status(400).json({ error: "Mật khẩu mới phải có ít nhất 8 ký tự" });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: "Mật khẩu mới phải khác mật khẩu cũ" });
    }
    if (user.twoFactorEnabled) {
      const step = verifyTotp(decrypt(user.twoFactorSecret), code, user.twoFactorLastStep ?? -1);
      if (step === null) return res.status(401).json({ error: "Mã xác thực 2 lớp không đúng" });
      user.twoFactorLastStep = step;
    }
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    await revokeAllSessions(user._id, "password_changed");
    await securityEvent({ type: "password_changed", severity: "warning", message: "Đổi mật khẩu — mọi phiên cũ đã bị đăng xuất", user, ip: req.ip });
    const { token, session } = await startSession(user, req);
    authCookie.sendLogin(req, res, { token, session, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi khi đổi mật khẩu" });
  }
});

// ---------------------------------------------------------------------
// Xác thực 2 lớp (TOTP)
// ---------------------------------------------------------------------

/** POST /api/auth/me/2fa/setup — tạo khoá bí mật mới, trả mã QR để quét bằng app Authenticator */
router.post("/me/2fa/setup", requireAuth, async (req, res) => {
  const user = await User.findById(req.dbUser._id);
  if (user.twoFactorEnabled) return res.status(409).json({ error: "Đã bật xác thực 2 lớp" });
  const secret = generateTotpSecret();
  user.twoFactorPendingSecret = encrypt(secret);
  await user.save();
  const uri = totpUri({ secret, account: user.username });
  res.json({ secret, otpauthUrl: uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) });
});

/** POST /api/auth/me/2fa/enable — body { code } — xác nhận bằng mã 6 số đầu tiên */
router.post("/me/2fa/enable", requireAuth, async (req, res) => {
  const user = await User.findById(req.dbUser._id);
  if (!user.twoFactorPendingSecret) return res.status(400).json({ error: "Chưa tạo mã QR — bấm Bật 2FA lại" });
  const secret = decrypt(user.twoFactorPendingSecret);
  const step = verifyTotp(secret, req.body && req.body.code);
  if (step === null) return res.status(401).json({ error: "Mã không đúng — kiểm tra lại giờ trên điện thoại" });
  const backupCodes = generateBackupCodes();
  user.twoFactorEnabled = true;
  user.twoFactorSecret = encrypt(secret);
  user.twoFactorPendingSecret = "";
  user.twoFactorLastStep = step;
  user.backupCodeHashes = backupCodes.map(hashBackupCode);
  await user.save();
  await securityEvent({ type: "mfa_enabled", severity: "info", message: "Bật xác thực 2 lớp", user, ip: req.ip });
  // Mã dự phòng chỉ hiện ĐÚNG 1 LẦN này — server chỉ lưu bản băm
  res.json({ ok: true, backupCodes });
});

/** POST /api/auth/me/2fa/disable — body { password, code } */
router.post("/me/2fa/disable", requireAuth, async (req, res) => {
  const user = await User.findById(req.dbUser._id);
  if (!user.twoFactorEnabled) return res.status(400).json({ error: "Chưa bật xác thực 2 lớp" });
  const { password, code } = req.body || {};
  if (!(await bcrypt.compare(String(password || ""), user.passwordHash))) {
    await registerFailure(user, req, "mật khẩu");
    return res.status(401).json({ error: "Mật khẩu không đúng" });
  }
  if (verifyTotp(decrypt(user.twoFactorSecret), code, user.twoFactorLastStep ?? -1) === null) {
    return res.status(401).json({ error: "Mã xác thực không đúng" });
  }
  user.twoFactorEnabled = false;
  user.twoFactorSecret = "";
  user.backupCodeHashes = [];
  user.twoFactorLastStep = -1;
  await user.save();
  await securityEvent({
    type: "mfa_disabled",
    severity: user.role === "admin" ? "critical" : "warning",
    message: "TẮT xác thực 2 lớp",
    user,
    ip: req.ip,
  });
  res.json({ ok: true });
});

/** POST /api/auth/me/2fa/backup-codes — body { code } — tạo bộ mã dự phòng mới (bộ cũ mất hiệu lực) */
router.post("/me/2fa/backup-codes", requireAuth, async (req, res) => {
  const user = await User.findById(req.dbUser._id);
  if (!user.twoFactorEnabled) return res.status(400).json({ error: "Chưa bật xác thực 2 lớp" });
  const step = verifyTotp(decrypt(user.twoFactorSecret), req.body && req.body.code, user.twoFactorLastStep ?? -1);
  if (step === null) return res.status(401).json({ error: "Mã xác thực không đúng" });
  const backupCodes = generateBackupCodes();
  user.backupCodeHashes = backupCodes.map(hashBackupCode);
  user.twoFactorLastStep = step;
  await user.save();
  res.json({ backupCodes });
});

// ---------------------------------------------------------------------
// Passkey (WebAuthn)
// ---------------------------------------------------------------------

const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const MAX_PASSKEYS = 10;

async function createChallenge(purpose, userId = "") {
  const challenge = webauthn.newChallenge();
  await WebauthnChallenge.create({
    _id: challenge,
    purpose,
    userId: String(userId || ""),
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
  return challenge;
}

/** Lấy thử thách từ clientDataJSON, kiểm tra rồi XOÁ NGAY (dùng 1 lần) */
async function consumeChallenge(credential, purpose) {
  let challenge = "";
  try {
    challenge = JSON.parse(webauthn.b64u.decode(credential.response.clientDataJSON).toString("utf8")).challenge;
  } catch {
    throw new Error("Dữ liệu passkey không hợp lệ");
  }
  // clientDataJSON do trình duyệt gửi lên (đã mã hoá base64 nên bộ lọc dò
  // lỗ hổng không nhìn thấy) → "challenge" có thể bị sửa thành object
  // {"$ne": ""} để khớp/xoá thử thách của NGƯỜI KHÁC. Chỉ nhận chuỗi.
  challenge = asId(challenge);
  if (!challenge) throw new Error("Dữ liệu passkey không hợp lệ");
  const doc = await WebauthnChallenge.findById(challenge);
  if (doc) await WebauthnChallenge.deleteOne({ _id: challenge });
  if (!doc || doc.purpose !== purpose || new Date(doc.expiresAt) < new Date()) {
    throw new Error("Yêu cầu passkey đã hết hạn hoặc đã được dùng — thử lại");
  }
  return doc;
}

// ---------------------------------------------------------------------
// XÁC THỰC LẠI (step-up) trước thao tác nhạy cảm — hiện dùng cho phát hành NFT.
// Mật khẩu + phiên đăng nhập là CHƯA ĐỦ: phải chứng minh lại bằng passkey
// (thiết bị của chính chủ) hoặc mã 6 số từ app Authenticator.
// ---------------------------------------------------------------------
const STEP_UP_MINUTES = Number(process.env.STEP_UP_MINUTES || 5);

/** POST /api/auth/me/step-up/options — cách xác thực khả dụng + thử thách passkey */
router.post("/me/step-up/options", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.dbUser._id);
    const passkeys = user.passkeys || [];
    const methods = [];
    if (passkeys.length) methods.push("passkey");
    if (user.twoFactorEnabled) methods.push("totp");
    if (!methods.length) {
      return res.status(403).json({
        code: "STRONG_AUTH_REQUIRED",
        error: "Tài khoản chưa bật passkey hoặc xác thực 2 lớp — vào mục Tài khoản của tôi để bật trước.",
      });
    }
    const out = { methods, minutes: STEP_UP_MINUTES };
    if (passkeys.length) {
      out.passkey = {
        challenge: await createChallenge("stepup", user._id),
        rpId: webauthn.rpId(),
        userVerification: "required",
        timeout: CHALLENGE_TTL_MS,
        allowCredentials: passkeys.map((p) => ({ type: "public-key", id: p.credId, transports: p.transports })),
      };
    }
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Không tạo được yêu cầu xác thực lại" });
  }
});

/** POST /api/auth/me/step-up — body { code } hoặc { credential } (passkey) */
router.post("/me/step-up", requireAuth, async (req, res) => {
  const user = await User.findById(req.dbUser._id);
  const { code, credential } = req.body || {};
  try {
    let method = "";
    if (credential) {
      const ch = await consumeChallenge(credential, "stepup");
      if (String(ch.userId) !== String(user._id)) throw new Error("Passkey không thuộc tài khoản đang đăng nhập");
      const stored = (user.passkeys || []).find((p) => p.credId === credential.id);
      if (!stored) throw new Error("Passkey không còn hiệu lực");
      const result = webauthn.verifyAuthentication(credential, ch._id, plainPasskey(stored));
      user.passkeys = user.passkeys.map((p) => {
        const o = plainPasskey(p);
        return o.credId === stored.credId ? { ...o, signCount: result.signCount, lastUsedAt: new Date() } : o;
      });
      method = `passkey "${stored.name}"`;
    } else {
      if (!user.twoFactorEnabled) throw new Error("Tài khoản chưa bật mã 6 số");
      const step = verifyTotp(decrypt(user.twoFactorSecret), String(code || ""), user.twoFactorLastStep ?? -1);
      if (step === null) {
        await registerFailure(user, req, "mã 2FA");
        return res.status(401).json({ error: "Mã xác thực không đúng" });
      }
      user.twoFactorLastStep = step;
      method = "mã 6 số";
    }
    user.failedLogins = 0;
    await user.save();
    const until = new Date(Date.now() + STEP_UP_MINUTES * 60 * 1000);
    await Session.updateOne({ _id: req.authSession._id }, { stepUpUntil: until });
    await securityEvent({ type: "step_up_ok", severity: "info", message: `Xác thực lại bằng ${method} để thao tác nhạy cảm`, user, ip: req.ip });
    res.json({ ok: true, until });
  } catch (err) {
    await securityEvent({
      type: "step_up_failed",
      severity: "warning",
      message: `Xác thực lại THẤT BẠI trước thao tác nhạy cảm: ${err.message}`,
      user,
      ip: req.ip,
    });
    res.status(401).json({ error: err.message || "Xác thực lại thất bại" });
  }
});

/** Chuyển passkey (có thể là subdocument Mongoose) thành object thường */
function plainPasskey(p) {
  return typeof p.toObject === "function" ? p.toObject() : { ...p };
}

function passkeyView(p) {
  return {
    id: p.credId,
    name: p.name,
    createdAt: p.createdAt,
    lastUsedAt: p.lastUsedAt,
    transports: p.transports || [],
  };
}

/**
 * POST /api/auth/me/passkeys/options — bước 1 thêm passkey.
 * body: { password } — BẮT BUỘC nhập lại mật khẩu: kẻ đánh cắp phiên đăng
 * nhập không lén cài passkey của hắn vào tài khoản để quay lại sau được.
 */
router.post("/me/passkeys/options", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.dbUser._id);
    if (!(await bcrypt.compare(String((req.body && req.body.password) || ""), user.passwordHash))) {
      await registerFailure(user, req, "mật khẩu");
      return res.status(401).json({ error: "Mật khẩu không đúng" });
    }
    if ((user.passkeys || []).length >= MAX_PASSKEYS) {
      return res.status(400).json({ error: `Tối đa ${MAX_PASSKEYS} passkey cho mỗi tài khoản` });
    }
    const challenge = await createChallenge("register", user._id);
    res.json({
      challenge,
      rp: { id: webauthn.rpId(), name: webauthn.rpName() },
      user: {
        id: webauthn.b64u.encode(Buffer.from(String(user._id))),
        name: user.username,
        displayName: user.displayName || user.username,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: webauthn.ALG_ES256 },
        { type: "public-key", alg: webauthn.ALG_RS256 },
      ],
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      attestation: "none",
      timeout: CHALLENGE_TTL_MS,
      excludeCredentials: (user.passkeys || []).map((p) => ({ type: "public-key", id: p.credId, transports: p.transports })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Không tạo được yêu cầu passkey" });
  }
});

/** POST /api/auth/me/passkeys — bước 2 thêm passkey. body: { name, credential } */
router.post("/me/passkeys", requireAuth, async (req, res) => {
  try {
    const { name, credential } = req.body || {};
    const ch = await consumeChallenge(credential, "register");
    if (ch.userId !== String(req.dbUser._id)) throw new Error("Yêu cầu passkey không thuộc tài khoản này");
    const reg = webauthn.verifyRegistration(credential, ch._id);

    const user = await User.findById(req.dbUser._id);
    if ((user.passkeys || []).some((p) => p.credId === reg.credId)) {
      return res.status(409).json({ error: "Passkey này đã được thêm trước đó" });
    }
    const label = String(name || "").trim().slice(0, 60) || "Passkey";
    user.passkeys = [...(user.passkeys || []).map(plainPasskey), { ...reg, name: label, createdAt: new Date(), lastUsedAt: null }];
    await user.save();

    await securityEvent({
      type: "passkey_added",
      severity: "warning",
      message: `Thêm passkey mới "${label}" — từ giờ đăng nhập bằng mật khẩu sẽ cần thêm bước xác thực`,
      user,
      ip: req.ip,
    });
    if (user.telegramChatId) {
      await sendTelegram(
        `🔑 Tài khoản "${user.username}" vừa THÊM passkey "${label}".\nNếu không phải bạn, vào Tài khoản của tôi để xoá passkey đó và đổi mật khẩu ngay.`,
        { chatId: user.telegramChatId }
      );
    }
    res.status(201).json(passkeyView(user.passkeys[user.passkeys.length - 1]));
  } catch (err) {
    res.status(400).json({ error: err.message || "Không thêm được passkey" });
  }
});

/** GET /api/auth/me/passkeys — danh sách passkey của tôi */
router.get("/me/passkeys", requireAuth, async (req, res) => {
  const user = await User.findById(req.dbUser._id);
  res.json((user.passkeys || []).map(passkeyView));
});

/** DELETE /api/auth/me/passkeys/:id — xoá 1 passkey */
router.delete("/me/passkeys/:id", requireAuth, async (req, res) => {
  const user = await User.findById(req.dbUser._id);
  const target = (user.passkeys || []).find((p) => p.credId === req.params.id);
  if (!target) return res.status(404).json({ error: "Không tìm thấy passkey" });
  user.passkeys = user.passkeys.filter((p) => p.credId !== req.params.id).map(plainPasskey);
  await user.save();
  await securityEvent({
    type: "passkey_removed",
    severity: "warning",
    message: `Xoá passkey "${target.name}"`,
    user,
    ip: req.ip,
  });
  res.json({ ok: true });
});

/**
 * POST /api/auth/passkey/login-options — thử thách đăng nhập.
 * body: { mfaToken? } — có mfaToken = đang ở bước 2 (đã qua mật khẩu) →
 * chỉ cho dùng passkey của đúng tài khoản đó. Không có = đăng nhập 1 chạm.
 */
router.post("/passkey/login-options", async (req, res) => {
  try {
    let userId = "";
    let allowCredentials = [];
    const mfaToken = req.body && req.body.mfaToken;
    if (mfaToken) {
      let payload;
      try {
        payload = jwt.verify(String(mfaToken), process.env.JWT_SECRET, { algorithms: ["HS256"] });
        if (payload.typ !== "mfa") throw new Error();
      } catch {
        return res.status(401).json({ error: "Phiên xác thực đã hết hạn — vui lòng đăng nhập lại." });
      }
      const user = await User.findById(payload.id);
      if (!user || !(user.passkeys || []).length) return res.status(400).json({ error: "Tài khoản chưa có passkey" });
      userId = String(user._id);
      allowCredentials = user.passkeys.map((p) => ({ type: "public-key", id: p.credId, transports: p.transports }));
    }
    const challenge = await createChallenge("login", userId);
    res.json({
      challenge,
      rpId: webauthn.rpId(),
      userVerification: "required",
      timeout: CHALLENGE_TTL_MS,
      allowCredentials,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Không tạo được yêu cầu passkey" });
  }
});

/**
 * POST /api/auth/login/passkey — đăng nhập bằng passkey.
 * body: { credential, mfaToken? }
 * Passkey = thiết bị (thứ bạn có) + vân tay/khuôn mặt/PIN (thứ bạn là/biết)
 * → tự nó đã là xác thực nhiều lớp, không hỏi thêm mã 6 số.
 */
router.post("/login/passkey", async (req, res) => {
  const { credential, mfaToken } = req.body || {};
  let user = null;
  try {
    const ch = await consumeChallenge(credential, "login");

    // Tìm tài khoản: theo userHandle (passkey tự khai) hoặc theo tài khoản của bước 2
    let userId = ch.userId;
    const handle = credential.response && credential.response.userHandle;
    if (handle) {
      const fromHandle = webauthn.b64u.decode(handle).toString("utf8");
      if (userId && fromHandle !== userId) throw new Error("Passkey không thuộc tài khoản đang đăng nhập");
      userId = fromHandle;
    }
    if (!userId) throw new Error("Không xác định được tài khoản của passkey");
    user = await User.findById(userId);
    const stored = user && (user.passkeys || []).find((p) => p.credId === credential.id);
    if (!stored) throw new Error("Passkey không còn hiệu lực (có thể đã bị xoá)");

    if (mfaToken) {
      let payload;
      try {
        payload = jwt.verify(String(mfaToken), process.env.JWT_SECRET, { algorithms: ["HS256"] });
      } catch {
        throw new Error("Phiên xác thực đã hết hạn — vui lòng đăng nhập lại.");
      }
      if (payload.typ !== "mfa" || String(payload.id) !== String(user._id)) throw new Error("Passkey không thuộc tài khoản đang đăng nhập");
    }

    const result = webauthn.verifyAuthentication(credential, ch._id, plainPasskey(stored));

    if (user.disabled) {
      await securityEvent({ type: "login_disabled_account", severity: "warning", message: "Đăng nhập passkey vào tài khoản đã bị khoá", user, ip: req.ip });
      return res.status(403).json({ error: "Tài khoản đã bị khoá. Liên hệ quản trị viên." });
    }

    user.passkeys = user.passkeys.map((p) => {
      const o = plainPasskey(p);
      return o.credId === stored.credId ? { ...o, signCount: result.signCount, lastUsedAt: new Date() } : o;
    });
    if (result.cloneWarning) {
      await securityEvent({
        type: "passkey_clone_suspected",
        severity: "critical",
        message: `Bộ đếm chữ ký của passkey "${stored.name}" bị lùi — nghi passkey đã bị sao chép. Nên xoá passkey này.`,
        user,
        ip: req.ip,
      });
    }
    await securityEvent({ type: "login_passkey", severity: "info", message: `Đăng nhập bằng passkey "${stored.name}"`, user, ip: req.ip });
    await completeLogin(user, req, res);
  } catch (err) {
    const msg = err.message || "Đăng nhập passkey thất bại";
    // Passkey bị dùng trên trang lạ = dấu hiệu web giả mạo
    const phishing = /trang lạ/.test(msg);
    await securityEvent({
      type: phishing ? "passkey_phishing_blocked" : "passkey_failed",
      severity: phishing ? "warning" : "info",
      message: `Đăng nhập passkey bị từ chối: ${msg}`,
      user: user || undefined,
      ip: req.ip,
    });
    res.status(401).json({ error: msg });
  }
});

// ---------------------------------------------------------------------
// Telegram cá nhân
// ---------------------------------------------------------------------

/**
 * POST /api/auth/me/telegram/link — tạo mã liên kết 10 phút.
 * Người dùng mở link t.me/<bot>?start=<mã> → bấm Start → backend (webhook)
 * nhận mã và gắn chat Telegram đó vào tài khoản.
 */
/**
 * Đổi / gỡ Telegram ĐÃ liên kết = thao tác nhạy cảm: kẻ chiếm được tài khoản
 * sẽ chuyển cảnh báo sang Telegram của hắn để chủ thật không biết gì nữa.
 * → bắt buộc vừa xác thực lại (passkey / mã 2FA). Lần liên kết ĐẦU TIÊN thì không cần.
 */
async function requireStepUpForTelegram(req, res) {
  const full = await User.findById(req.dbUser._id);
  if (!full.telegramChatId) return { ok: true, full };
  const strong = full.twoFactorEnabled || (full.passkeys || []).length > 0;
  if (!strong) {
    await securityEvent({
      type: "telegram_change_blocked",
      severity: "warning",
      message: "Thử đổi/gỡ Telegram nhưng tài khoản chưa bật passkey/2FA — đã chặn (nhờ admin xác minh nếu là chủ thật)",
      user: full,
      ip: req.ip,
    });
    res.status(403).json({
      code: "STRONG_AUTH_REQUIRED",
      error: "Đổi hoặc gỡ Telegram cần xác thực lại bằng passkey / mã 2FA. Tài khoản chưa bật — hãy bật trước, hoặc nhờ quản trị viên.",
    });
    return { ok: false };
  }
  if (!req.authSession.stepUpUntil || new Date(req.authSession.stepUpUntil) < new Date()) {
    res.status(403).json({ code: "STEP_UP_REQUIRED", error: "Cần xác thực lại bằng passkey / mã 2FA trước khi đổi Telegram." });
    return { ok: false };
  }
  return { ok: true, full };
}

const TG_CHANGE_MINUTES = 10;
const TG_ACTION_VI = { unlink: "GỠ liên kết Telegram", relink: "ĐỔI sang Telegram khác" };

/**
 * Gỡ / đổi Telegram đã liên kết phải được CHÍNH Telegram hiện tại duyệt.
 * Trả { ok:true } khi đã có duyệt hợp lệ cho đúng phiên + thao tác này (và
 * đánh dấu đã dùng). Ngược lại trả 202 (đang chờ) hoặc 403 (bị từ chối).
 */
async function requireTelegramOwnerApproval(req, res, full, action) {
  const sid = String(req.authSession._id);
  const now = new Date();
  const last = await TelegramChange.findOne({ userId: full._id, sessionId: sid, action }).sort({ createdAt: -1 });

  if (last && last.status === "approved" && new Date(last.expiresAt) > now) {
    // Đổi trạng thái nguyên tử: 1 lần duyệt chỉ dùng được đúng 1 lần
    const used = await TelegramChange.findOneAndUpdate({ _id: last._id, status: "approved" }, { status: "used" });
    if (used) return { ok: true };
  }
  if (last && last.status === "denied" && new Date(last.expiresAt) > now) {
    res.status(403).json({ code: "TELEGRAM_CHANGE_DENIED", error: "Yêu cầu đã bị TỪ CHỐI trên Telegram của chủ tài khoản." });
    return { ok: false };
  }
  if (last && last.status === "pending" && new Date(last.expiresAt) > now) {
    res.status(202).json({ code: "TELEGRAM_CHANGE_PENDING", requestId: last._id, minutes: TG_CHANGE_MINUTES });
    return { ok: false };
  }

  const id = crypto.randomBytes(12).toString("hex");
  await TelegramChange.create({
    _id: id,
    userId: full._id,
    sessionId: sid,
    action,
    ip: req.ip,
    expiresAt: new Date(Date.now() + TG_CHANGE_MINUTES * 60 * 1000),
  });
  await sendTelegram(
    `🔐 YÊU CẦU ${TG_ACTION_VI[action]} của tài khoản "${full.username}".\n` +
      `IP: ${req.ip}\n\n` +
      "Nếu đúng là bạn, bấm ✅ Cho phép. Nếu KHÔNG phải bạn, bấm 🚫 — thiết bị đó bị đăng xuất ngay và quản trị viên được báo.\n" +
      `(Hết hạn sau ${TG_CHANGE_MINUTES} phút.)`,
    {
      chatId: full.telegramChatId,
      buttons: [
        [{ text: "✅ Cho phép", callback_data: `tgok:${id}` }],
        [{ text: "🚫 Không phải tôi", callback_data: `tgno:${id}` }],
      ],
    }
  ).catch(() => {});
  await securityEvent({
    type: "telegram_change_requested",
    severity: "warning",
    message: `Yêu cầu ${TG_ACTION_VI[action]} — đang chờ chính Telegram hiện tại duyệt`,
    user: full,
    ip: req.ip,
  });
  res.status(202).json({ code: "TELEGRAM_CHANGE_PENDING", requestId: id, minutes: TG_CHANGE_MINUTES });
  return { ok: false };
}

/** GET /api/auth/me/telegram/change/:id — trạng thái yêu cầu (chỉ chủ + đúng phiên) */
router.get("/me/telegram/change/:id", requireAuth, async (req, res) => {
  const id = asId(req.params.id);
  const r = id ? await TelegramChange.findById(id) : null;
  if (!r || String(r.userId) !== String(req.dbUser._id) || r.sessionId !== String(req.authSession._id)) {
    return res.json({ status: "not_found" });
  }
  if (r.status === "pending" && new Date(r.expiresAt) < new Date()) return res.json({ status: "expired" });
  res.json({ status: r.status });
});

router.post("/me/telegram/link", requireAuth, async (req, res) => {
  const bot = process.env.TELEGRAM_BOT_USERNAME;
  if (!process.env.TELEGRAM_BOT_TOKEN || !bot) {
    return res.status(503).json({ error: "Hệ thống chưa cấu hình Telegram bot (TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME)" });
  }
  const gate = await requireStepUpForTelegram(req, res);
  if (!gate.ok) return;
  if (gate.full.telegramChatId) {
    const ap = await requireTelegramOwnerApproval(req, res, gate.full, "relink");
    if (!ap.ok) return;
  }
  const code = crypto.randomBytes(12).toString("hex");
  await User.updateOne(
    { _id: req.dbUser._id },
    { telegramLinkCode: code, telegramLinkExpires: new Date(Date.now() + 10 * 60 * 1000), telegramLinkSession: req.authSession._id }
  );
  res.json({ url: `https://t.me/${bot.replace(/^@/, "")}?start=${code}`, expiresInMinutes: 10 });
});

/** DELETE /api/auth/me/telegram — huỷ liên kết (cần xác thực lại) */
router.delete("/me/telegram", requireAuth, async (req, res) => {
  const gate = await requireStepUpForTelegram(req, res);
  if (!gate.ok) return;
  if (gate.full.telegramChatId) {
    const ap = await requireTelegramOwnerApproval(req, res, gate.full, "unlink");
    if (!ap.ok) return;
  }
  const old = gate.full.telegramChatId;
  await User.updateOne(
    { _id: req.dbUser._id },
    { telegramChatId: "", telegramPrevChatId: old, telegramPrevUntil: new Date(Date.now() + 24 * 3600 * 1000) }
  );
  if (old) {
    await sendTelegram(
      `⚠️ Tài khoản "${gate.full.username}" vừa GỠ liên kết Telegram này (IP ${req.ip}).\nTừ giờ bạn sẽ không nhận cảnh báo nữa.\n\nNếu KHÔNG phải bạn, bấm nút dưới để khoá tài khoản ngay.`,
      { chatId: old, buttons: [[{ text: "🚫 Không phải tôi — khoá tài khoản", callback_data: `notme:${req.authSession._id}` }]] }
    ).catch(() => {});
  }
  await securityEvent({ type: "telegram_unlinked", severity: "warning", message: "Huỷ liên kết Telegram nhận cảnh báo (đã xác thực lại + chính Telegram cũ đã cho phép)", user: req.dbUser, ip: req.ip });
  res.json({ ok: true });
});

/**
 * POST /api/auth/me/wallet/nonce — bước 1 liên kết ví.
 * body: { walletAddress } → trả về { message } để MetaMask ký (personal_sign).
 */
router.post("/me/wallet/nonce", requireAuth, async (req, res) => {
  const { walletAddress } = req.body;
  if (!ethers.isAddress(walletAddress || "")) {
    return res.status(400).json({ error: "Địa chỉ ví không hợp lệ" });
  }
  const address = ethers.getAddress(walletAddress);
  const nonce = crypto.randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS);

  await User.updateOne(
    { _id: req.user.id },
    { walletNonce: nonce, walletNonceFor: address.toLowerCase(), walletNonceExpires: expiresAt }
  );

  const message = buildWalletLinkMessage({
    origin: req.headers.origin,
    username: req.dbUser.username,
    address,
    nonce,
    expiresAt,
  });
  res.json({ message });
});

/**
 * PATCH /api/auth/me/wallet — bước 2 liên kết ví.
 * body: { walletAddress, message, signature }
 *
 * Backend tự kiểm tra chữ ký: chỉ chủ thật của ví mới ký được → kẻ chiếm
 * tài khoản không thể gắn ví lạ mà không có private key ví đó.
 * Nếu tài khoản ĐÃ ĐƯỢC DUYỆT mà đổi sang ví khác → báo động đỏ cho admin.
 */
router.patch("/me/wallet", requireAuth, async (req, res) => {
  try {
    const { walletAddress, message, signature } = req.body;
    if (!ethers.isAddress(walletAddress || "") || !message || !signature) {
      return res.status(400).json({ error: "Thiếu địa chỉ ví hoặc chữ ký" });
    }
    const address = ethers.getAddress(walletAddress).toLowerCase();

    const user = await User.findById(req.user.id);
    if (!user.walletNonce || !user.walletNonceExpires || user.walletNonceExpires < new Date()) {
      return res.status(400).json({ error: "Yêu cầu ký đã hết hạn — vui lòng thử lại" });
    }
    if (user.walletNonceFor !== address || !String(message).includes(`Nonce: ${user.walletNonce}`)) {
      return res.status(400).json({ error: "Tin nhắn ký không khớp yêu cầu" });
    }

    let recovered;
    try {
      recovered = ethers.verifyMessage(String(message), String(signature)).toLowerCase();
    } catch {
      return res.status(400).json({ error: "Chữ ký không hợp lệ" });
    }
    // Nonce dùng 1 lần — xoá ngay dù đúng hay sai
    user.walletNonce = "";
    user.walletNonceFor = "";
    user.walletNonceExpires = null;

    if (recovered !== address) {
      await user.save();
      await securityEvent({
        type: "wallet_signature_mismatch",
        severity: "warning",
        message: "Chữ ký liên kết ví không khớp địa chỉ khai báo",
        user,
        wallet: address,
        ip: req.ip,
      });
      return res.status(400).json({ error: "Chữ ký không khớp với địa chỉ ví" });
    }

    const owner = await User.findOne({ walletAddress: address, _id: { $ne: user._id } }).select("_id");
    if (owner) {
      await user.save();
      return res.status(409).json({ error: "Ví này đã được liên kết với một tài khoản khác" });
    }

    const oldWallet = user.walletAddress || "";
    const wasApproved = user.roleStatus === "da_duyet";

    if (oldWallet === address) {
      // Cùng ví — chỉ cập nhật thời điểm xác minh, KHÔNG reset trạng thái duyệt
      user.walletVerifiedAt = new Date();
      await user.save();
    } else {
      user.previousWallet = oldWallet;
      user.walletAddress = address;
      user.walletVerifiedAt = new Date();
      user.walletChangedAt = oldWallet ? new Date() : null;
      user.roleStatus = "cho_duyet";
      await user.save();

      await securityEvent({
        type: oldWallet ? "wallet_changed" : "wallet_linked",
        severity: oldWallet ? (wasApproved ? "critical" : "warning") : "info",
        message: oldWallet
          ? `Tài khoản${wasApproved ? " ĐÃ DUYỆT" : ""} đổi ví ${oldWallet} → ${address}. ` +
            "Xác minh với đối tác qua kênh khác (gọi điện) TRƯỚC khi cấp quyền cho ví mới. " +
            (wasApproved ? "Cân nhắc thu hồi quyền on-chain của ví cũ." : "")
          : "Liên kết ví mới, đang chờ duyệt",
        user,
        wallet: address,
        ip: req.ip,
        meta: { oldWallet },
      });
    }

    const fresh = await User.findById(user._id).select(PRIVATE_FIELDS);
    res.json(fresh);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi khi liên kết ví" });
  }
});

// ---------------------------------------------------------------------
// Chỉ admin
// ---------------------------------------------------------------------

/** GET /api/auth/blocked-ips — IP đang bị chặn */
router.get("/blocked-ips", requireAuth, requireAdmin, async (req, res) => {
  res.json(await ipBlock.listBlocked());
});

/** POST /api/auth/blocked-ips — body { ip, minutes, reason } */
router.post("/blocked-ips", requireAuth, requireAdmin, async (req, res) => {
  const ip = String((req.body && req.body.ip) || "").trim();
  const minutes = Math.min(Math.max(Number(req.body && req.body.minutes) || 60, 5), 30 * 24 * 60);
  if (!ipBlock.isValidIp(ip)) return res.status(400).json({ error: "Địa chỉ IP không hợp lệ" });
  if (ip === req.ip) return res.status(400).json({ error: "Không thể chặn chính IP bạn đang dùng" });
  const reason = String((req.body && req.body.reason) || "Admin chặn thủ công").slice(0, 200);
  const ok = await ipBlock.blockIp(ip, { minutes, reason, by: req.dbUser.username });
  if (!ok) return res.status(400).json({ error: "IP này nằm trong danh sách trắng (IP_ALLOWLIST) nên không bị chặn" });
  res.json({ ok: true });
});

/** DELETE /api/auth/blocked-ips/:ip */
router.delete("/blocked-ips/:ip", requireAuth, requireAdmin, async (req, res) => {
  await ipBlock.unblockIp(String(req.params.ip), req.dbUser.username);
  res.json({ ok: true });
});

/** GET /api/auth/users — danh sách tài khoản cho màn "Quản lý người dùng" */
router.get("/users", requireAuth, requireAdmin, async (req, res) => {
  const users = await User.find().select(PRIVATE_FIELDS).sort({ createdAt: -1 });
  res.json(users);
});

/**
 * PATCH /api/auth/users/:id/approve — đánh dấu đã duyệt SAU KHI quyền
 * on-chain đã thật sự được cấp. Backend tự đọc contract.hasRole() để kiểm
 * tra, không tin lời frontend.
 */
router.patch("/users/:id/approve", requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "Không tìm thấy tài khoản" });
    if (!user.walletAddress || !user.walletVerifiedAt) {
      return res.status(409).json({ error: "Tài khoản chưa liên kết ví bằng chữ ký" });
    }
    const roleName = USER_ROLE_TO_CONTRACT_ROLE[user.role];
    if (!roleName) return res.status(400).json({ error: "Vai trò này không có quyền on-chain tương ứng" });

    const contract = getReadOnlyContract();
    const hasRole = await contract.hasRole(await contract[roleName](), user.walletAddress);
    if (!hasRole) {
      return res.status(409).json({ error: "Chưa thấy quyền trên blockchain cho ví này — giao dịch cấp quyền chưa thành công?" });
    }

    user.roleStatus = "da_duyet";
    await user.save();
    await securityEvent({
      type: "user_approved",
      severity: "info",
      message: `Admin ${req.dbUser.username} duyệt ${roleName} cho tài khoản`,
      user,
      wallet: user.walletAddress,
      ip: req.ip,
    });
    res.json(await User.findById(user._id).select(PRIVATE_FIELDS));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Không kiểm tra được quyền trên blockchain" });
  }
});

/**
 * PATCH /api/auth/users/:id/disable — khoá / mở khoá tài khoản.
 * body: { disabled: true|false }. Khoá = đăng xuất mọi phiên ngay lập tức.
 * Lưu ý: khoá tài khoản web KHÔNG tước quyền on-chain của ví — muốn vậy
 * phải dùng Guardian (flagCompromised) hoặc Operator (revokeRole).
 */
router.patch("/users/:id/disable", requireAuth, requireAdmin, async (req, res) => {
  const disabled = Boolean(req.body && req.body.disabled);
  if (String(req.params.id) === String(req.dbUser._id)) {
    return res.status(400).json({ error: "Không thể tự khoá tài khoản của chính mình" });
  }
  const user = await User.findByIdAndUpdate(
    req.params.id,
    disabled ? { $set: { disabled: true }, $inc: { tokenVersion: 1 } } : { $set: { disabled: false } },
    { new: true }
  ).select(PRIVATE_FIELDS);
  if (!user) return res.status(404).json({ error: "Không tìm thấy tài khoản" });
  await securityEvent({
    type: disabled ? "user_disabled" : "user_enabled",
    severity: "warning",
    message: `Admin ${req.dbUser.username} ${disabled ? "KHOÁ" : "mở khoá"} tài khoản`,
    user,
    ip: req.ip,
  });
  res.json(user);
});

/** POST /api/auth/users/:id/revoke-sessions — đăng xuất mọi phiên của tài khoản */
/**
 * POST /api/auth/users/:id/telegram-reset — admin gỡ Telegram cho người dùng
 * đã MẤT Telegram cũ (không thể tự bấm duyệt). Admin phải xác minh danh tính
 * ngoài hệ thống trước; mọi phiên của tài khoản bị đăng xuất cho chắc.
 */
router.post("/users/:id/telegram-reset", requireAuth, requireAdmin, async (req, res) => {
  const id = asId(req.params.id);
  const user = id ? await User.findById(id) : null;
  if (!user) return res.status(404).json({ error: "Không tìm thấy tài khoản" });
  const old = user.telegramChatId;
  await User.updateOne(
    { _id: user._id },
    { telegramChatId: "", telegramPrevChatId: old || "", telegramPrevUntil: new Date(Date.now() + 24 * 3600 * 1000), $inc: { tokenVersion: 1 } }
  );
  if (old) {
    await sendTelegram(`⚠️ Quản trị viên vừa gỡ Telegram này khỏi tài khoản "${user.username}" theo yêu cầu khôi phục.`, { chatId: old }).catch(() => {});
  }
  await securityEvent({
    type: "telegram_reset_by_admin",
    severity: "warning",
    message: `Admin ${req.dbUser.username} gỡ Telegram của tài khoản (người dùng mất Telegram cũ) — đã đăng xuất mọi phiên`,
    user,
    ip: req.ip,
  });
  res.json({ ok: true });
});

router.post("/users/:id/revoke-sessions", requireAuth, requireAdmin, async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, { $inc: { tokenVersion: 1 } }, { new: true }).select(
    PRIVATE_FIELDS
  );
  if (!user) return res.status(404).json({ error: "Không tìm thấy tài khoản" });
  await securityEvent({
    type: "sessions_revoked",
    severity: "warning",
    message: `Admin ${req.dbUser.username} đăng xuất mọi phiên của tài khoản`,
    user,
    ip: req.ip,
  });
  res.json({ ok: true });
});

// Sự kiện cần xử lý = mức cảnh báo/nghiêm trọng chưa được đánh dấu xong
// (bản ghi cũ trước khi có trường status cũng tính là chưa xử lý)
const OPEN_FILTER = { severity: { $in: ["warning", "critical"] }, status: { $nin: ["resolved", "false_positive"] } };

/**
 * GET /api/auth/audit?severity=warning|critical&status=open — nhật ký bảo mật mới nhất
 */
router.get("/audit", requireAuth, requireAdmin, async (req, res) => {
  let filter = {};
  if (req.query.status === "open") filter = { ...OPEN_FILTER };
  if (req.query.severity === "warning") filter.severity = { $in: ["warning", "critical"] };
  if (req.query.severity === "critical") filter.severity = "critical";
  const logs = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  res.json(logs);
});

/** GET /api/auth/audit/summary — số cảnh báo chưa xử lý (hiện trên menu) */
router.get("/audit/summary", requireAuth, requireAdmin, async (req, res) => {
  const [open, critical] = await Promise.all([
    AuditLog.countDocuments(OPEN_FILTER),
    AuditLog.countDocuments({ ...OPEN_FILTER, severity: "critical" }),
  ]);
  res.json({ open, critical });
});

/**
 * PATCH /api/auth/audit/:id — đánh dấu xử lý sự cố.
 * body: { status: "resolved" | "false_positive" | "open", note }
 */
router.patch("/audit/:id", requireAuth, requireAdmin, async (req, res) => {
  const { status, note } = req.body || {};
  if (!["resolved", "false_positive", "open"].includes(status)) {
    return res.status(400).json({ error: "Trạng thái không hợp lệ" });
  }
  const log = await AuditLog.findById(req.params.id);
  if (!log) return res.status(404).json({ error: "Không tìm thấy sự kiện" });
  if (log.severity === "info") return res.status(400).json({ error: "Sự kiện thông tin không cần xử lý" });
  const update =
    status === "open"
      ? { status, handledBy: "", handledAt: null, resolutionNote: "" }
      : { status, handledBy: req.dbUser.username, handledAt: new Date(), resolutionNote: String(note || "").slice(0, 500) };
  await AuditLog.updateOne({ _id: log._id }, update);
  res.json({ ...(await AuditLog.findById(log._id).lean()) });
});

module.exports = router;
