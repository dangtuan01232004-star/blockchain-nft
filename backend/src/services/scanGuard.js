const ScanLog = require("../models/ScanLog");

/**
 * PHÁT HIỆN QUÉT BẤT THƯỜNG (nghi mã QR bị sao chép).
 *
 * Bản cũ cảnh báo quá sớm: đếm MỌI lần tải trang (kể cả bấm tải lại trên cùng
 * 1 máy) và cảnh báo ngay cả khi sản phẩm CHƯA BÁN — trong khi ở cửa hàng,
 * nhiều khách quét thử cùng 1 món hàng là chuyện bình thường.
 *
 * Quy tắc mới:
 *  1. Cùng 1 thiết bị quét lại trong SCAN_DEDUPE_MINUTES (mặc định 30 phút)
 *     → chỉ tính 1 lượt (tải lại trang không làm tăng số đếm).
 *  2. Lượt quét của CHÍNH CHỦ (trình duyệt đã kích hoạt mã cào) không tính.
 *  3. Chỉ đánh giá SAU KHI sản phẩm đã có chủ (đã nhập mã cào): một món hàng
 *     đã bán mà vẫn bị NHIỀU thiết bị lạ quét → nghi mã QR bị in lên hàng giả.
 *     Trước khi bán, việc chống sao chép do MÃ CÀO đảm nhận (mã dùng 1 lần).
 *
 *   SCAN_MAX_DEVICES: số thiết bị lạ tối đa được quét SAU KHI đã có chủ
 *                      trước khi bị coi là bất thường (mặc định 3).
 */
const SCAN_MAX_DEVICES = Number(process.env.SCAN_MAX_DEVICES || 3);
const SCAN_DEDUPE_MINUTES = Number(process.env.SCAN_DEDUPE_MINUTES || 30);

/** Ghi lại một lượt quét (bỏ qua nếu cùng thiết bị vừa quét gần đây) */
async function recordScan(tokenId, deviceId, ip, userAgent) {
  try {
    const dev = deviceId || "unknown";
    const since = new Date(Date.now() - SCAN_DEDUPE_MINUTES * 60 * 1000);
    if (dev !== "unknown") {
      const recent = await ScanLog.countDocuments({ tokenId: String(tokenId), deviceId: dev, createdAt: { $gte: since } });
      if (recent > 0) return false;
    }
    await ScanLog.create({ tokenId: String(tokenId), deviceId: dev, ip, userAgent });
    return true;
  } catch (err) {
    console.error("Không ghi được lượt quét:", err.message);
    return false;
  }
}

/**
 * Đánh giá mức độ bất thường.
 * @param {string} tokenId
 * @param {{status:string, claimedAt?:Date}} claim  trạng thái mã cào của sản phẩm
 * @returns {Promise<{distinctDevices:number, totalScans:number, suspicious:boolean, sinceClaim:boolean}>}
 */
async function evaluateSuspicion(tokenId, claim = {}) {
  try {
    const claimed = claim && claim.claimedAt && ["owner", "claimed_by_other"].includes(claim.status);
    if (!claimed) {
      // Chưa bán: không cảnh báo theo lượt quét (mã cào lo phần chống sao chép)
      return { distinctDevices: 0, totalScans: 0, suspicious: false, sinceClaim: false };
    }
    const filter = { tokenId: String(tokenId), createdAt: { $gte: new Date(claim.claimedAt) } };
    const [ids, totalScans] = await Promise.all([ScanLog.distinct("deviceId", filter), ScanLog.countDocuments(filter)]);
    const distinctDevices = ids.filter((d) => d && d !== "unknown").length;
    return { distinctDevices, totalScans, suspicious: distinctDevices > SCAN_MAX_DEVICES, sinceClaim: true };
  } catch (err) {
    console.error("Không đánh giá được lượt quét:", err.message);
    return { distinctDevices: 0, totalScans: 0, suspicious: false, sinceClaim: false };
  }
}

module.exports = { recordScan, evaluateSuspicion, SCAN_MAX_DEVICES, SCAN_DEDUPE_MINUTES };
