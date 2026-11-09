const crypto = require("crypto");
const ProductClaim = require("../models/ProductClaim");
const { getKey, encrypt, maskPhone } = require("./crypto");
const { getReadOnlyContract, loadContractInfo } = require("./blockchain");
const { securityEvent } = require("./alerts");

/**
 * Mã cào dùng 1 lần — logic nghiệp vụ.
 *
 * Mã: 10 ký tự, bảng chữ 31 ký tự đã bỏ các ký tự dễ nhầm (0/O, 1/I/L),
 * in dạng K7QM-4XPA-9R → ~49 bit ngẫu nhiên. Kết hợp khoá 5 lần sai/sản
 * phẩm, đoán mò gần như không thể.
 *
 * Băm: HMAC-SHA256 với khoá bí mật suy ra từ DATA_ENCRYPTION_KEY ("pepper").
 * Không có khoá thì không thử được mã nào, kể cả khi lấy được toàn bộ DB.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 10;
const MAX_FAILED = Number(process.env.CLAIM_MAX_FAILED || 5);
const LOCK_MINUTES = Number(process.env.CLAIM_LOCK_MINUTES || 60);

function pepper() {
  return crypto.createHmac("sha256", getKey()).update("claim-code-pepper:v1").digest();
}

function currentContract() {
  return String(loadContractInfo().address || "").toLowerCase();
}

function generateCode() {
  // Lấy mẫu không lệch (rejection sampling) để mỗi ký tự đều xác suất như nhau
  let out = "";
  while (out.length < CODE_LEN) {
    const b = crypto.randomBytes(16);
    for (const x of b) {
      if (x < 248 && out.length < CODE_LEN) out += ALPHABET[x % 31];
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

/** Chuẩn hoá mã người dùng gõ: bỏ khoảng trắng, gạch, viết hoa */
function normalizeCode(input) {
  return String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function hashCode(contract, tokenId, code) {
  return crypto
    .createHmac("sha256", pepper())
    .update(`${contract}:${tokenId}:${normalizeCode(code)}`)
    .digest("hex");
}

function hashOwnerToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function safeEqualHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function maskContact(contact) {
  const c = String(contact || "").trim();
  if (!c) return "";
  if (c.includes("@")) {
    const [u, d] = c.split("@");
    return `${u.slice(0, 2)}***@${d}`;
  }
  return maskPhone(c);
}

/** Ví đã mint token này (đọc trên chain) */
async function getMinter(tokenId) {
  const contract = getReadOnlyContract();
  try {
    const m = await contract.mintedBy(tokenId);
    if (m && m !== "0x0000000000000000000000000000000000000000") return m.toLowerCase();
  } catch {
    /* contract cũ chưa có mintedBy() */
  }
  const history = await contract.getHistory(tokenId);
  return history.length ? String(history[0].actor).toLowerCase() : "";
}

/**
 * Sinh mã cho sản phẩm. Chỉ ví đã mint (hoặc admin) được sinh.
 * @param {{regenerate?: boolean}} opts regenerate = cấp lại (mã cũ mất hiệu lực)
 * @returns {Promise<{ok: true, code: string, version: number} | {ok: false, status: number, error: string}>}
 */
async function issueClaimCode(tokenId, user, req, { regenerate = false } = {}) {
  tokenId = String(tokenId);
  if (!/^\d+$/.test(tokenId)) return { ok: false, status: 400, error: "Token ID không hợp lệ" };

  let minter;
  try {
    minter = await getMinter(tokenId);
  } catch {
    return { ok: false, status: 404, error: "Sản phẩm không tồn tại trên blockchain" };
  }
  const isAdmin = user.role === "admin";
  if (!isAdmin && (!user.walletAddress || user.walletAddress.toLowerCase() !== minter)) {
    return { ok: false, status: 403, error: "Chỉ ví đã phát hành sản phẩm này mới được tạo mã cào" };
  }

  const contract = currentContract();
  const existing = await ProductClaim.findOne({ contract, tokenId });
  if (existing && existing.claimedAt) {
    return { ok: false, status: 409, error: "Sản phẩm đã được người mua kích hoạt — không thể cấp lại mã" };
  }
  if (existing && !regenerate) {
    return { ok: false, status: 409, error: "Sản phẩm đã có mã cào. Dùng chức năng Cấp lại mã nếu tem bị hỏng." };
  }

  const code = generateCode();
  const codeHash = hashCode(contract, tokenId, code);
  let version = 1;
  if (existing) {
    version = (existing.codeVersion || 1) + 1;
    await ProductClaim.updateOne(
      { _id: existing._id },
      { codeHash, codeVersion: version, codeIssuedAt: new Date(), codeIssuedBy: user.username, failedAttempts: 0, lockedUntil: null }
    );
    await securityEvent({
      type: "claim_code_regenerated",
      severity: "warning",
      message: `Cấp lại mã cào cho sản phẩm #${tokenId} (lần ${version}) — mã/tem cũ mất hiệu lực`,
      user,
      ip: req.ip,
    });
  } else {
    await ProductClaim.create({ contract, tokenId, codeHash, codeIssuedBy: user.username });
  }
  return { ok: true, code, version };
}

/**
 * Người mua kích hoạt bằng mã cào.
 * @returns {Promise<{status: number, body: object}>}
 */
async function claimProduct(tokenId, code, contact, req) {
  tokenId = String(tokenId);
  const contract = currentContract();
  const claim = await ProductClaim.findOne({ contract, tokenId });
  if (!claim) {
    return { status: 404, body: { error: "Sản phẩm này chưa được cấp mã cào.", claimStatus: "no_code" } };
  }
  if (claim.lockedUntil && new Date(claim.lockedUntil) > new Date()) {
    const mins = Math.ceil((new Date(claim.lockedUntil) - Date.now()) / 60000);
    return { status: 423, body: { error: `Nhập sai quá nhiều lần. Thử lại sau ${mins} phút.`, claimStatus: "locked" } };
  }

  const ok = normalizeCode(code).length === CODE_LEN && safeEqualHex(hashCode(contract, tokenId, code), claim.codeHash);

  if (!ok) {
    const failed = (claim.failedAttempts || 0) + 1;
    const update = { failedAttempts: failed };
    if (failed >= MAX_FAILED) {
      update.failedAttempts = 0;
      update.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60000);
    }
    await ProductClaim.updateOne({ _id: claim._id }, update);
    if (failed >= MAX_FAILED) {
      await securityEvent({
        type: "claim_code_bruteforce",
        severity: "warning",
        message: `Sản phẩm #${tokenId}: nhập sai mã cào ${MAX_FAILED} lần liên tiếp — khoá ${LOCK_MINUTES} phút. Có thể có người đang đoán mã.`,
        ip: req.ip,
      });
    }
    return {
      status: 400,
      body: {
        error: failed >= MAX_FAILED ? `Sai mã. Đã khoá nhập mã ${LOCK_MINUTES} phút.` : `Mã không đúng. Còn ${MAX_FAILED - failed} lần thử.`,
      },
    };
  }

  if (claim.claimedAt) {
    // Mã đúng nhưng đã có người kích hoạt trước → tem thật đã bị dùng
    await securityEvent({
      type: "claim_code_reused",
      severity: "warning",
      message: `Sản phẩm #${tokenId}: có người nhập ĐÚNG mã cào nhưng sản phẩm đã được kích hoạt từ ${new Date(claim.claimedAt).toLocaleString("vi-VN")} — nghi tem bị sao chép hoặc hàng đã qua tay`,
      ip: req.ip,
    });
    return {
      status: 409,
      body: { error: "Mã này đã được dùng để kích hoạt trước đó.", claimStatus: "claimed_by_other", claimedAt: claim.claimedAt },
    };
  }

  const ownerToken = crypto.randomBytes(32).toString("base64url");
  const contactStr = String(contact || "").trim().slice(0, 120);
  // Cập nhật NGUYÊN TỬ: chỉ thành công nếu vẫn chưa ai kích hoạt — 2 người
  // nhập cùng lúc thì chỉ 1 người thắng
  const won = await ProductClaim.findOneAndUpdate(
    { _id: claim._id, claimedAt: null },
    {
      claimedAt: new Date(),
      ownerTokenHash: hashOwnerToken(ownerToken),
      contactEnc: contactStr ? encrypt(contactStr) : "",
      contactMasked: maskContact(contactStr),
      failedAttempts: 0,
    },
    { new: true }
  );
  if (!won) {
    return { status: 409, body: { error: "Sản phẩm vừa được kích hoạt bởi người khác.", claimStatus: "claimed_by_other" } };
  }
  return { status: 200, body: { ok: true, claimStatus: "owner", ownerToken, claimedAt: won.claimedAt } };
}

/** Trạng thái để hiển thị khi quét QR */
async function getClaimStatus(tokenId, ownerToken) {
  const claim = await ProductClaim.findOne({ contract: currentContract(), tokenId: String(tokenId) });
  if (!claim) return { status: "no_code" };
  const locked = claim.lockedUntil && new Date(claim.lockedUntil) > new Date();
  if (!claim.claimedAt) return { status: locked ? "locked" : "unclaimed" };
  if (ownerToken && safeEqualHex(hashOwnerToken(ownerToken), claim.ownerTokenHash)) {
    return { status: "owner", claimedAt: claim.claimedAt };
  }
  return { status: "claimed_by_other", claimedAt: claim.claimedAt, reportCount: claim.reportCount || 0 };
}

/** Người quét báo "nghi hàng giả" */
async function reportProduct(tokenId, message, contact, req) {
  const contract = currentContract();
  const claim = await ProductClaim.findOne({ contract, tokenId: String(tokenId) });
  if (claim) await ProductClaim.updateOne({ _id: claim._id }, { $inc: { reportCount: 1 } });
  const contactStr = String(contact || "").trim().slice(0, 120);
  await securityEvent({
    type: "product_reported",
    severity: "warning",
    message:
      `Người tiêu dùng báo NGHI HÀNG GIẢ sản phẩm #${tokenId}` +
      (claim && claim.claimedAt ? ` (đã được kích hoạt lúc ${new Date(claim.claimedAt).toLocaleString("vi-VN")})` : "") +
      (message ? `: "${String(message).slice(0, 300)}"` : ""),
    ip: req.ip,
    meta: { tokenId: String(tokenId), contact: contactStr ? encrypt(contactStr) : "" },
  });
}

/**
 * Admin cấp lại quyền chủ (khách đổi điện thoại / xoá trình duyệt), SAU KHI
 * đã xác minh danh tính qua điện thoại. Trả token mới; token cũ mất hiệu lực.
 */
async function recoverOwnership(tokenId, adminUser, req) {
  const claim = await ProductClaim.findOne({ contract: currentContract(), tokenId: String(tokenId) });
  if (!claim || !claim.claimedAt) return { ok: false, status: 404, error: "Sản phẩm chưa được kích hoạt" };
  const ownerToken = crypto.randomBytes(32).toString("base64url");
  await ProductClaim.updateOne({ _id: claim._id }, { ownerTokenHash: hashOwnerToken(ownerToken) });
  await securityEvent({
    type: "claim_owner_recovered",
    severity: "warning",
    message: `Admin ${adminUser.username} cấp lại quyền chủ sở hữu sản phẩm #${tokenId} (liên hệ đăng ký: ${claim.contactMasked || "không có"})`,
    user: adminUser,
    ip: req.ip,
  });
  return { ok: true, ownerToken, contactMasked: claim.contactMasked };
}

module.exports = {
  generateCode,
  normalizeCode,
  hashCode,
  issueClaimCode,
  claimProduct,
  getClaimStatus,
  reportProduct,
  recoverOwnership,
  CODE_LEN,
};
