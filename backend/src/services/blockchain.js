/**
 * Service kết nối blockchain — CHỈ ĐỌC (read-only).
 *
 * Kiến trúc mới: backend không giữ private key của bất kỳ vai trò nào.
 * Mọi giao dịch ghi lên chain (mint, transferCustody, revoke...) được ký
 * trực tiếp từ ví của người dùng (MetaMask) ngay trên trình duyệt — xem
 * frontend/js/web3.js. Backend chỉ dùng provider để:
 *   - đọc dữ liệu on-chain (verifyProduct, getHistory) phục vụ trang xác thực
 *   - phục vụ địa chỉ hợp đồng + ABI cho frontend qua /api/contract/config
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const CONTRACT_JSON_PATH = path.join(__dirname, "..", "data", "contract.json");

function loadContractInfo() {
  if (!fs.existsSync(CONTRACT_JSON_PATH)) {
    throw new Error(
      "Không tìm thấy backend/src/data/contract.json. Hãy chạy `npm run deploy:local` trong thư mục smart-contracts trước."
    );
  }
  const info = JSON.parse(fs.readFileSync(CONTRACT_JSON_PATH, "utf-8"));
  return {
    address: process.env.CONTRACT_ADDRESS || info.address,
    abi: info.abi,
  };
}

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "http://127.0.0.1:8545");

function getReadOnlyContract() {
  const { address, abi } = loadContractInfo();
  return new ethers.Contract(address, abi, provider);
}

module.exports = { getReadOnlyContract, loadContractInfo, provider };
