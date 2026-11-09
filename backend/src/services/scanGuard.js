const ScanLog = require("../models/ScanLog");

/**
 * Ngưỡng phát hiện bất thường — cấu hình qua .env, có giá trị mặc định
 * hợp lý cho môi trường demo/dev:
 *   SCAN_MAX_DEVICES: số thiết bị KHÁC NHAU tối đa được coi là bình thường
 *                      cho cùng 1 sản phẩm (vượt ngưỡng này → nghi ngờ QR
 *                      đã bị sao chép sang nhiều sản phẩm giả).
 *   SCAN_MAX_TOTAL:    tổng số lượt quét tối đa (không phân biệt thiết bị)
 *                      trước khi bị đánh dấu là quét bất thường.
 */
const SCAN_MAX_DEVICES = Number(process.env.SCAN_MAX_DEVICES || 3);
const SCAN_MAX_TOTAL = Number(process.env.SCAN_MAX_TOTAL || 15);

/** Ghi lại một lượt quét — không chặn phản hồi chính nếu MongoDB gặp sự cố */
async function recordScan(tokenId, deviceId, ip, userAgent) {
  try {
    await ScanLog.create({ tokenId: String(tokenId), deviceId: deviceId || "unknown", ip, userAgent });
  } catch (err) {
    console.error("Không ghi được lượt quét:", err.message);
  }
}

/**
 * Đánh giá mức độ bất thường của lượt quét dựa trên lịch sử đã ghi.
 * @returns {Promise<{distinctDevices: number, totalScans: number, suspicious: boolean}>}
 */
async function evaluateSuspicion(tokenId) {
  try {
    const [distinctDeviceIds, totalScans] = await Promise.all([
      ScanLog.distinct("deviceId", { tokenId: String(tokenId) }),
      ScanLog.countDocuments({ tokenId: String(tokenId) }),
    ]);
    const distinctDevices = distinctDeviceIds.length;
    const suspicious = distinctDevices > SCAN_MAX_DEVICES || totalScans > SCAN_MAX_TOTAL;
    return { distinctDevices, totalScans, suspicious };
  } catch (err) {
    console.error("Không đánh giá được lượt quét:", err.message);
    return { distinctDevices: 0, totalScans: 0, suspicious: false };
  }
}

module.exports = { recordScan, evaluateSuspicion, SCAN_MAX_DEVICES, SCAN_MAX_TOTAL };
