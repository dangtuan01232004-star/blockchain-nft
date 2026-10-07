require("@nomicfoundation/hardhat-toolbox");
require("hardhat-gas-reporter");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {},
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    // Mạng testnet (ví dụ Sepolia) — điền RPC_URL và PRIVATE_KEY trong file .env
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  // Đo chi phí gas của từng hàm — phục vụ mục 3.4 "Đánh giá thực nghiệm"
  // trong đề cương. Chạy `npm run test:gas` để in ra bảng chi phí.
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    // Để trống coinmarketcap = không quy đổi ra USD, chỉ hiện số gas thô
    // (đủ dùng cho báo cáo). Muốn quy đổi USD thật, đăng ký free API key
    // tại https://coinmarketcap.com/api và điền vào COINMARKETCAP_API_KEY.
    coinmarketcap: process.env.COINMARKETCAP_API_KEY || undefined,
    excludeContracts: [],
  },
};
