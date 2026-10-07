const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

async function main() {
  const signers = await hre.ethers.getSigners();
  const deployer = signers[0];
  console.log("Triển khai hợp đồng với tài khoản:", deployer.address);

  const ProductNFT = await hre.ethers.getContractFactory("ProductNFT");
  const contract = await ProductNFT.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("ProductNFT đã được triển khai tại địa chỉ:", address);

  const MANUFACTURER_ROLE = await contract.MANUFACTURER_ROLE();
  const DISTRIBUTOR_ROLE = await contract.DISTRIBUTOR_ROLE();

  // Trên mạng local (Hardhat node) có sẵn 20 tài khoản test — mặc định dùng
  // luôn signer #1 làm nhà sản xuất, #2 làm phân phối, KHÔNG cần cấu hình gì.
  //
  // Trên mạng công khai (Sepolia, mainnet...) chỉ có ĐÚNG 1 tài khoản khả
  // dụng (ví của bạn, lấy từ PRIVATE_KEY trong .env) — phải tự chỉ định địa
  // chỉ ví thật của nhà sản xuất/phân phối qua 2 biến môi trường
  // MANUFACTURER_ADDRESS / DISTRIBUTOR_ADDRESS (có thể dùng chính ví của bạn
  // cho cả 2 vai trò nếu demo một mình).
  const manufacturerAddress = process.env.MANUFACTURER_ADDRESS || (signers[1] && signers[1].address);
  const distributorAddress = process.env.DISTRIBUTOR_ADDRESS || (signers[2] && signers[2].address);

  if (manufacturerAddress) {
    await (await contract.grantRole(MANUFACTURER_ROLE, manufacturerAddress)).wait();
    console.log("Đã cấp MANUFACTURER_ROLE cho:", manufacturerAddress);
  } else {
    console.log(
      "⚠ Chưa cấp MANUFACTURER_ROLE cho ai — đặt MANUFACTURER_ADDRESS trong .env rồi chạy lại, hoặc tự gọi contract.grantRole() sau."
    );
  }

  if (distributorAddress) {
    await (await contract.grantRole(DISTRIBUTOR_ROLE, distributorAddress)).wait();
    console.log("Đã cấp DISTRIBUTOR_ROLE cho:", distributorAddress);
  } else {
    console.log(
      "⚠ Chưa cấp DISTRIBUTOR_ROLE cho ai — đặt DISTRIBUTOR_ADDRESS trong .env rồi chạy lại, hoặc tự gọi contract.grantRole() sau."
    );
  }

  // Ghi địa chỉ + ABI ra backend để backend tự động đọc khi khởi động
  const artifact = await hre.artifacts.readArtifact("ProductNFT");
  const outDir = path.join(__dirname, "..", "..", "backend", "src", "data");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "contract.json"),
    JSON.stringify({ address, abi: artifact.abi }, null, 2)
  );
  console.log("Đã ghi địa chỉ + ABI vào backend/src/data/contract.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
