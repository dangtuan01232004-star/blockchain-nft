const express = require("express");
const { loadContractInfo } = require("../services/blockchain");

const router = express.Router();

/**
 * GET /api/contract/config
 * Trả về địa chỉ hợp đồng + ABI để frontend tự khởi tạo `ethers.Contract`
 * và ký giao dịch trực tiếp bằng ví người dùng (MetaMask) — không qua backend.
 * Đây là dữ liệu công khai (địa chỉ hợp đồng vốn đã public trên blockchain),
 * an toàn khi expose qua API không cần xác thực.
 */
router.get("/config", (req, res) => {
  try {
    const { address, abi } = loadContractInfo();
    res.json({
      address,
      abi,
      rpcUrl: process.env.RPC_URL || "http://127.0.0.1:8545",
      chainIdHex: process.env.CHAIN_ID_HEX || "0x7a69", // 31337 — Hardhat local mặc định
      chainName: process.env.CHAIN_NAME || "Hardhat Local",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
