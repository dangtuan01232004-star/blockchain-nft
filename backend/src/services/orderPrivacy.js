const Order = require("../models/Order");
const AuditLog = require("../models/AuditLog");
const { encrypt, decrypt, isEncrypted, maskPhone, maskName, maskAddress } = require("./crypto");
const { securityEvent } = require("./alerts");

/**
 * Bảo vệ thông tin cá nhân người mua trong đơn hàng:
 *  - mã hoá khi lưu, che khi hiển thị
 *  - mở xem đầy đủ phải qua revealOrder() → ghi log + đếm + bẫy canary
 *  - xoá (ẩn danh) thông tin sau thời hạn lưu trữ
 *
 * Cấu hình:
 *   ORDER_RETENTION_DAYS=90        xoá thông tin cá nhân N ngày sau khi giao xong
 *   ORDER_MAX_RETENTION_DAYS=180   xoá cả đơn chưa giao sau N ngày
 *   REVEAL_ALERT_PER_HOUR=20       1 tài khoản mở > N đơn/giờ → cảnh báo
 *   REVEAL_LIMIT_PER_HOUR=50       1 tài khoản mở > N đơn/giờ → chặn
 */
const RETENTION_DAYS = Number(process.env.ORDER_RETENTION_DAYS || 90);
const MAX_RETENTION_DAYS = Number(process.env.ORDER_MAX_RETENTION_DAYS || 180);
const REVEAL_ALERT = Number(process.env.REVEAL_ALERT_PER_HOUR || 20);
const REVEAL_LIMIT = Number(process.env.REVEAL_LIMIT_PER_HOUR || 50);

/** Chuẩn bị dữ liệu để lưu đơn mới */
function protectBuyerFields({ buyerName, buyerPhone, buyerAddress, note }) {
  return {
    buyerName: encrypt(buyerName),
    buyerPhone: encrypt(buyerPhone),
    buyerAddress: encrypt(buyerAddress),
    note: note ? encrypt(note) : "",
    buyerNameMasked: maskName(buyerName),
    buyerPhoneMasked: maskPhone(buyerPhone),
    buyerAddressMasked: maskAddress(buyerAddress),
  };
}

/** Bản hiển thị danh sách: CHỈ dữ liệu đã che, không bao giờ có bản mã hoá / cờ canary */
function maskedView(order) {
  const o = typeof order.toObject === "function" ? order.toObject() : { ...order };
  return {
    _id: o._id,
    tokenId: o.tokenId,
    productName: o.productName,
    productCode: o.productCode,
    buyerName: o.anonymizedAt ? "(đã xoá)" : o.buyerNameMasked || maskName(decryptSafe(o.buyerName)),
    buyerPhone: o.anonymizedAt ? "(đã xoá)" : o.buyerPhoneMasked || maskPhone(decryptSafe(o.buyerPhone)),
    buyerAddress: o.anonymizedAt ? "(đã xoá)" : o.buyerAddressMasked || maskAddress(decryptSafe(o.buyerAddress)),
    hasNote: Boolean(o.note),
    status: o.status,
    deliveredAt: o.deliveredAt,
    anonymized: Boolean(o.anonymizedAt),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    masked: true,
  };
}

function decryptSafe(v) {
  try {
    return decrypt(v);
  } catch {
    return "";
  }
}

/**
 * Mở xem đầy đủ thông tin người mua của 1 đơn — có kiểm soát:
 * ghi nhật ký, đếm số lần mở / giờ, chặn khi vượt ngưỡng, báo động nếu là đơn bẫy.
 * @returns {Promise<{ok: true, data} | {ok: false, status, error}>}
 */
async function revealOrder(order, user, req) {
  if (order.anonymizedAt) {
    return { ok: false, status: 410, error: "Thông tin người mua đã được xoá theo chính sách lưu trữ dữ liệu." };
  }

  // Đếm số lần mở trong 1 giờ qua của tài khoản này
  const since = Date.now() - 60 * 60 * 1000;
  const recent = await AuditLog.countDocuments({
    type: "order_pii_revealed",
    userId: user._id,
    createdAt: { $gte: new Date(since) },
  });
  if (recent >= REVEAL_LIMIT) {
    await securityEvent({
      type: "order_reveal_blocked",
      severity: "critical",
      message: `Chặn xem thông tin khách hàng: tài khoản đã mở ${recent} đơn trong 1 giờ (giới hạn ${REVEAL_LIMIT}) — nghi đang bị thu thập dữ liệu`,
      user,
      ip: req.ip,
      dedupeKey: `reveal-block:${user._id}:${Math.floor(Date.now() / 3600000)}`,
    });
    return { ok: false, status: 429, error: "Bạn đã xem quá nhiều đơn trong 1 giờ. Thử lại sau." };
  }

  await securityEvent({
    type: "order_pii_revealed",
    severity: "info",
    message: `Xem đầy đủ thông tin người mua đơn ${order._id} (sản phẩm #${order.tokenId})`,
    user,
    ip: req.ip,
    meta: { orderId: String(order._id) },
  });
  await Order.updateOne({ _id: order._id }, { $inc: { revealCount: 1 } });

  if (recent + 1 === REVEAL_ALERT) {
    await securityEvent({
      type: "order_reveal_burst",
      severity: "warning",
      message: `Tài khoản đã mở thông tin ${REVEAL_ALERT} khách hàng trong 1 giờ — bất thường, kiểm tra xem có bị chiếm tài khoản không`,
      user,
      ip: req.ip,
    });
  }

  if (order.isCanary) {
    // Không ai có lý do chính đáng mở đơn bẫy → gần như chắc chắn có người đang dò dữ liệu
    await securityEvent({
      type: "canary_triggered",
      severity: "critical",
      message:
        `BẪY DỮ LIỆU bị kích hoạt: đơn bẫy ${order._id} vừa bị mở xem đầy đủ. ` +
        "Tài khoản này có thể đang bị kẻ lạ dùng để thu thập thông tin khách hàng — khoá tài khoản và kiểm tra ngay.",
      user,
      ip: req.ip,
      meta: { orderId: String(order._id) },
    });
  }

  return {
    ok: true,
    data: {
      _id: order._id,
      buyerName: decrypt(order.buyerName),
      buyerPhone: decrypt(order.buyerPhone),
      buyerAddress: decrypt(order.buyerAddress),
      note: decrypt(order.note),
    },
  };
}

/**
 * Chạy định kỳ:
 *  1. Mã hoá các đơn cũ còn lưu dạng chữ thường (dữ liệu từ trước bản cập nhật)
 *  2. Xoá thông tin cá nhân của đơn quá hạn lưu trữ
 */
async function runOrderPrivacyMaintenance() {
  const now = Date.now();
  let encrypted = 0;
  let anonymized = 0;
  const orders = await Order.find({ anonymizedAt: null });
  for (const o of orders) {
    if (o.isCanary) continue;
    const delivered = o.deliveredAt ? new Date(o.deliveredAt).getTime() : null;
    const created = new Date(o.createdAt).getTime();
    const expired =
      (delivered && now - delivered > RETENTION_DAYS * 86400000) || now - created > MAX_RETENTION_DAYS * 86400000;

    if (expired) {
      await Order.updateOne(
        { _id: o._id },
        {
          buyerName: "-",
          buyerPhone: "-",
          buyerAddress: "-",
          note: "",
          buyerNameMasked: "",
          buyerPhoneMasked: "",
          buyerAddressMasked: "",
          anonymizedAt: new Date(),
        }
      );
      anonymized++;
      continue;
    }

    if (!isEncrypted(o.buyerPhone) || !isEncrypted(o.buyerName) || !isEncrypted(o.buyerAddress)) {
      const plain = {
        buyerName: decryptSafe(o.buyerName),
        buyerPhone: decryptSafe(o.buyerPhone),
        buyerAddress: decryptSafe(o.buyerAddress),
        note: decryptSafe(o.note),
      };
      await Order.updateOne({ _id: o._id }, protectBuyerFields(plain));
      encrypted++;
    }
  }
  if (encrypted || anonymized) {
    console.log(`Bảo vệ dữ liệu đơn hàng: mã hoá ${encrypted} đơn cũ, xoá thông tin ${anonymized} đơn quá hạn.`);
  }
  return { encrypted, anonymized };
}

module.exports = { protectBuyerFields, maskedView, revealOrder, runOrderPrivacyMaintenance, RETENTION_DAYS };
