const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { transferAdmin } = require("./lib/adminTransfer");

/**
 * Chuyển quyền ADMIN cao nhất của contract ĐANG CHẠY sang ví Safe multisig 2/3
 * — KHÔNG cần deploy lại, không mất sản phẩm đã mint.
 *
 * Chạy 2 bước (an toàn, có đường lui):
 *
 *   Bước 1 — cấp admin cho Safe (ví cũ vẫn giữ admin):
 *     npx hardhat run scripts/transfer-admin-to-safe.js --network sepolia
 *
 *   → Thử 1 thao tác admin qua app.safe.global (vd. clearCompromised) cho chắc Safe dùng được.
 *
 *   Bước 2 — ví cũ từ bỏ admin (KHÔNG hoàn tác được):
 *     RENOUNCE=yes npx hardhat run scripts/transfer-admin-to-safe.js --network sepolia
 *     (Windows Git Bash dùng y hệt; PowerShell: $env:RENOUNCE="yes"; npx hardhat run ...)
 *
 * Biến môi trường (smart-contracts/.env):
 *   PRIVATE_KEY             ví admin hiện tại (ví A)
 *   ADMIN_MULTISIG_ADDRESS  địa chỉ Safe (lấy trong app.safe.global)
 *   CONTRACT_ADDRESS        (tuỳ chọn) mặc định đọc backend/src/data/contract.json
 */
async function main() {
  const safeAddress = (process.env.ADMIN_MULTISIG_ADDRESS || "").trim();
  if (!safeAddress) throw new Error("Chưa điền ADMIN_MULTISIG_ADDRESS (địa chỉ ví Safe) trong smart-contracts/.env");

  let contractAddress = (process.env.CONTRACT_ADDRESS || "").trim();
  if (!contractAddress) {
    const file = path.join(__dirname, "..", "..", "backend", "src", "data", "contract.json");
    if (!fs.existsSync(file)) throw new Error("Không tìm thấy backend/src/data/contract.json — điền CONTRACT_ADDRESS trong .env");
    contractAddress = JSON.parse(fs.readFileSync(file, "utf8")).address;
  }

  const [signer] = await hre.ethers.getSigners();
  const renounce = String(process.env.RENOUNCE || "").toLowerCase() === "yes";
  console.log(`Mạng: ${hre.network.name}`);
  console.log(`Contract: ${contractAddress}`);
  console.log(`Ví chạy script: ${signer.address}`);
  console.log(renounce ? "Chế độ: BƯỚC 2 — từ bỏ quyền admin của ví này\n" : "Chế độ: BƯỚC 1 — cấp admin cho Safe\n");

  const contract = await hre.ethers.getContractAt("ProductNFT", contractAddress);
  const r = await transferAdmin({ ethers: hre.ethers, contract, signer, safeAddress, renounce });

  const OPERATOR = await contract.OPERATOR_ROLE();
  const GUARDIAN = await contract.GUARDIAN_ROLE();
  const [op, gu] = await Promise.all([contract.hasRole(OPERATOR, signer.address), contract.hasRole(GUARDIAN, signer.address)]);

  console.log("\n===== KẾT QUẢ =====");
  console.log(`Safe giữ ADMIN:          ${r.safeHasAdmin ? "CÓ ✓" : "KHÔNG ✗"}`);
  console.log(`Ví ${signer.address.slice(0, 8)}… giữ ADMIN: ${r.meHasAdmin ? "CÓ (còn đường lui)" : "KHÔNG ✓"}`);
  console.log(`Ví này giữ OPERATOR:     ${op ? "có" : "không"}   GUARDIAN: ${gu ? "có" : "không"}`);
  if (!renounce) {
    console.log("\nViệc tiếp theo:");
    console.log("  1. Vào app.safe.global → Safe của bạn → thử 1 giao dịch admin (xem hướng dẫn).");
    console.log("  2. Thành công rồi mới chạy BƯỚC 2:  RENOUNCE=yes npx hardhat run scripts/transfer-admin-to-safe.js --network sepolia");
  } else {
    console.log("\nXong. Từ giờ: mở lại hệ thống (unpause), gỡ cờ ví, cấp/thu hồi quyền OPERATOR/GUARDIAN");
    console.log("CHỈ làm được qua Safe với 2/3 chữ ký. Ví này vẫn dùng cho việc hằng ngày (duyệt đối tác, dừng khẩn cấp).");
  }
}

main().catch((e) => {
  console.error("\n✗ " + (e.shortMessage || e.message));
  process.exitCode = 1;
});
