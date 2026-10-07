const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const CONTRACT_PATH = path.join(DATA_DIR, "contract.json");
const MARKER_PATH = path.join(DATA_DIR, ".last-contract-address");

/**
 * Mỗi lần deploy lại smart contract, địa chỉ hợp đồng thay đổi và bộ đếm
 * tokenId trên chain reset về 0 — nhưng cache hiển thị ở trang quản trị
 * (products.json, partners.json) không tự biết điều đó, dẫn tới hiện tượng
 * nhiều sản phẩm khác nhau cùng hiện "#0" (thực ra thuộc các hợp đồng khác
 * nhau, hợp đồng cũ không còn tồn tại nữa).
 *
 * Hàm này chạy mỗi khi backend khởi động: so sánh địa chỉ contract hiện tại
 * với địa chỉ lần chạy trước — nếu khác nhau (đã deploy lại), tự động xoá
 * sạch cache cũ vì nó không còn khớp với contract đang chạy.
 */
function clearDirContents(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  for (const file of fs.readdirSync(dirPath)) {
    fs.rmSync(path.join(dirPath, file), { force: true });
  }
}

function resetCacheIfContractChanged() {
  if (!fs.existsSync(CONTRACT_PATH)) return;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { address } = JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf-8"));
  const lastAddress = fs.existsSync(MARKER_PATH) ? fs.readFileSync(MARKER_PATH, "utf-8").trim() : null;

  if (lastAddress !== address) {
    console.log(
      `Phát hiện địa chỉ contract mới (${address})${lastAddress ? ` khác lần chạy trước (${lastAddress})` : ""} ` +
      `— tự động xoá cache sản phẩm/đối tác/QR/metadata cũ vì không còn khớp với contract hiện tại.`
    );
    fs.writeFileSync(path.join(DATA_DIR, "products.json"), "[]");
    fs.writeFileSync(path.join(DATA_DIR, "partners.json"), "[]");
    clearDirContents(path.join(DATA_DIR, "qrcodes"));
    clearDirContents(path.join(DATA_DIR, "metadata"));
    fs.writeFileSync(MARKER_PATH, address);
  }
}

module.exports = { resetCacheIfContractChanged };
