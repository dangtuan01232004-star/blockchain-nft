/**
 * MINT HAI CHỮ KÝ — phía hệ thống.
 *
 * Khoá uỷ quyền (MINT_AUTHORIZER_KEY, chỉ nằm trên Render) KHÔNG có quyền gì
 * trên contract, KHÔNG cần ETH. Nó chỉ ký "cho phép ví X mint đúng sản phẩm Y
 * trong 10 phút" — và chỉ ký khi đủ các điều kiện dưới. Smart contract từ chối
 * mọi lệnh mint thiếu chữ ký này.
 *
 * Điều kiện cấp chữ ký:
 *  1. Tài khoản nhà sản xuất đã được duyệt, ví mint = đúng ví đã liên kết (SIWE)
 *  2. VỪA xác thực lại bằng passkey / mã 2FA (step-up, hiệu lực vài phút)
 *  3. Ví không bị gắn cờ xâm phạm, vẫn còn quyền MANUFACTURER, hệ thống không tạm dừng
 *  4. Không xin phép dồn dập bất thường (vượt ngưỡng → chặn + báo động)
 */
const crypto = require("crypto");
const { ethers } = require("ethers");
const AuditLog = require("../models/AuditLog");
const { getReadOnlyContract, loadContractInfo, provider } = require("./blockchain");
const { securityEvent, sendTelegram } = require("./alerts");
const { signMintAuth } = require("./mintAuthSign");

const VALID_MINUTES = 10;
const BURST_WINDOW_MIN = 10;
const BURST_MAX = Number(process.env.MINT_AUTH_BURST_MAX || 10);

class MintAuthError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let cachedSigner = null;
function authorizerWallet() {
  if (cachedSigner) return cachedSigner;
  const key = (process.env.MINT_AUTHORIZER_KEY || "").trim();
  if (!key) return null;
  cachedSigner = new ethers.Wallet(key.startsWith("0x") ? key : "0x" + key);
  return cachedSigner;
}

let cachedChainId = null;
async function chainId() {
  if (cachedChainId === null) cachedChainId = Number((await provider.getNetwork()).chainId);
  return cachedChainId;
}

const str = (v, max) => {
  const s = String(v ?? "");
  if (s.length > max) throw new MintAuthError(400, "Dữ liệu sản phẩm quá dài");
  return s;
};

async function issueMintAuthorization({ user, session, ip, body }) {
  const signer = authorizerWallet();
  if (!signer) throw new MintAuthError(503, "Hệ thống chưa cấu hình khoá uỷ quyền mint (MINT_AUTHORIZER_KEY)", "NOT_CONFIGURED");

  if (user.role !== "manufacturer") throw new MintAuthError(403, "Chỉ tài khoản nhà sản xuất mới được phát hành sản phẩm");
  const hasStrong = user.twoFactorEnabled || (user.passkeys && user.passkeys.length > 0);
  if (!hasStrong) {
    throw new MintAuthError(403, "Phải bật passkey hoặc xác thực 2 lớp trước khi phát hành sản phẩm (mục Tài khoản của tôi).", "STRONG_AUTH_REQUIRED");
  }
  if (!session.stepUpUntil || new Date(session.stepUpUntil) < new Date()) {
    throw new MintAuthError(403, "Cần xác thực lại bằng passkey / mã 2FA trước khi phát hành.", "STEP_UP_REQUIRED");
  }

  const minter = String(body.minter || "").toLowerCase();
  const to = String(body.to || "").toLowerCase();
  if (!user.walletAddress || !user.walletVerifiedAt || minter !== user.walletAddress.toLowerCase()) {
    await securityEvent({
      type: "mint_auth_wrong_wallet",
      severity: "critical",
      message: `Xin phép mint bằng ví ${minter || "(trống)"} KHÁC ví đã liên kết ${user.walletAddress || "(chưa có)"} — có thể ví lạ đang dùng tài khoản này`,
      user,
      wallet: minter,
      ip,
    });
    throw new MintAuthError(403, "Ví đang kết nối không phải ví đã liên kết với tài khoản này.");
  }
  if (to !== minter) throw new MintAuthError(400, "Sản phẩm mới phải được phát hành về chính ví nhà sản xuất.");

  const p = {
    tokenURI: str(body.tokenURI, 300),
    productCode: str(body.productCode, 100),
    photoURI: str(body.photoURI, 300),
    gps: str(body.gpsCoords, 60),
  };
  if (!p.tokenURI || !p.productCode) throw new MintAuthError(400, "Thiếu metadata hoặc mã sản phẩm");

  // Kiểm tra trên blockchain
  const contract = getReadOnlyContract();
  const [isMaker, compromised, paused, onchainAuthorizer] = await Promise.all([
    contract.hasRole(await contract.MANUFACTURER_ROLE(), minter),
    contract.compromisedSince(minter),
    contract.paused(),
    contract.mintAuthorizer().catch(() => ethers.ZeroAddress),
  ]);
  if (compromised > 0n) {
    await securityEvent({
      type: "mint_auth_flagged_wallet",
      severity: "critical",
      message: `Ví ĐÃ BỊ GẮN CỜ xâm phạm vẫn đang xin phép mint`,
      user,
      wallet: minter,
      ip,
    });
    throw new MintAuthError(403, "Ví này đã bị gắn cờ xâm phạm — không được phát hành.");
  }
  if (!isMaker) throw new MintAuthError(403, "Ví chưa có quyền nhà sản xuất trên blockchain.");
  if (paused) throw new MintAuthError(409, "Hệ thống đang tạm dừng khẩn cấp.");
  if (onchainAuthorizer.toLowerCase() !== signer.address.toLowerCase()) {
    throw new MintAuthError(503, "Khoá uỷ quyền trên server không khớp khoá đã đăng ký trên contract — báo quản trị viên.", "AUTHORIZER_MISMATCH");
  }

  // Chống xin phép dồn dập (ví + tài khoản bị chiếm, kẻ tấn công mint hàng loạt)
  const since = new Date(Date.now() - BURST_WINDOW_MIN * 60 * 1000);
  const recent = await AuditLog.countDocuments({ type: "mint_authorized", userId: user._id, createdAt: { $gte: since } });
  if (recent >= BURST_MAX) {
    await securityEvent({
      type: "mint_auth_burst",
      severity: "critical",
      message: `Xin phép mint ${recent + 1} lần trong ${BURST_WINDOW_MIN} phút — vượt ngưỡng ${BURST_MAX}, ĐÃ CHẶN. Nghi tài khoản + ví nhà sản xuất bị chiếm.`,
      user,
      wallet: minter,
      ip,
      dedupeKey: `mintburst:${user._id}:${Math.floor(Date.now() / (BURST_WINDOW_MIN * 60 * 1000))}`,
    });
    await require("./ipBlock").blockIp(ip, { auto: true, reason: "xin phép mint dồn dập" }).catch(() => {});
    throw new MintAuthError(429, `Phát hành quá nhiều trong ${BURST_WINDOW_MIN} phút — tạm chặn để kiểm tra. Liên hệ quản trị viên nếu là thao tác thật.`);
  }

  const nonce = "0x" + crypto.randomBytes(32).toString("hex");
  const deadline = Math.floor(Date.now() / 1000) + VALID_MINUTES * 60;
  const { address } = loadContractInfo();
  const signature = await signMintAuth(signer, {
    chainId: await chainId(),
    contract: address,
    minter: ethers.getAddress(minter),
    to: ethers.getAddress(to),
    ...p,
    nonce,
    deadline,
  });

  await securityEvent({
    type: "mint_authorized",
    severity: "info",
    message: `Cấp phép phát hành sản phẩm ${p.productCode} (hiệu lực ${VALID_MINUTES} phút)`,
    user,
    wallet: minter,
    ip,
    meta: { productCode: p.productCode, nonce },
  });
  // Báo chính chủ: nếu KHÔNG phải họ → bấm khoá ngay
  if (user.telegramChatId) {
    sendTelegram(
      `🏭 Tài khoản "${user.username}" vừa được cấp phép phát hành sản phẩm ${p.productCode}\nIP: ${ip}\n\nNếu KHÔNG phải bạn, bấm nút dưới để khoá tài khoản ngay.`,
      { chatId: user.telegramChatId, buttons: [[{ text: "🚫 Không phải tôi — khoá tài khoản", callback_data: `notme:${session._id}` }]] }
    ).catch(() => {});
  }

  return { nonce, deadline, signature, authorizer: signer.address };
}

module.exports = { issueMintAuthorization, MintAuthError, authorizerWallet };
