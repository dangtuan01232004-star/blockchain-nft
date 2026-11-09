const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

/**
 * Triển khai ProductNFT và thiết lập mô hình phân quyền nhiều tầng.
 *
 * Biến môi trường (smart-contracts/.env), tất cả đều tuỳ chọn:
 *   ADMIN_MULTISIG_ADDRESS  Ví Safe multisig sẽ giữ DEFAULT_ADMIN_ROLE.
 *                           Nếu có: ví deploy tự TỪ BỎ mọi quyền sau khi cấu hình xong.
 *   OPERATOR_ADDRESS        Ví duyệt đối tác hằng ngày (cấp quyền NSX/phân phối).
 *   GUARDIAN_ADDRESS        Ví phản ứng khẩn cấp (pause, gắn cờ ví bị hack, thu hồi).
 *   MANUFACTURER_ADDRESS    Ví nhà sản xuất cấp quyền sẵn lúc deploy.
 *   DISTRIBUTOR_ADDRESS     Ví phân phối cấp quyền sẵn lúc deploy.
 *
 * Mạng local (npx hardhat node) không cần .env: dùng signer #1 làm NSX,
 * #2 làm phân phối; ví deploy (#0) giữ admin + operator + guardian để demo.
 */
async function main() {
  const signers = await hre.ethers.getSigners();
  const deployer = signers[0];
  const isLocal = ["hardhat", "localhost"].includes(hre.network.name);
  console.log(`Mạng: ${hre.network.name}`);
  console.log("Triển khai hợp đồng với tài khoản:", deployer.address);

  const ProductNFT = await hre.ethers.getContractFactory("ProductNFT");
  const contract = await ProductNFT.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("ProductNFT đã được triển khai tại địa chỉ:", address);

  const ROLE = {
    ADMIN: await contract.DEFAULT_ADMIN_ROLE(),
    OPERATOR: await contract.OPERATOR_ROLE(),
    GUARDIAN: await contract.GUARDIAN_ROLE(),
    MANUFACTURER: await contract.MANUFACTURER_ROLE(),
    DISTRIBUTOR: await contract.DISTRIBUTOR_ROLE(),
  };

  const env = (name) => {
    const v = (process.env[name] || "").trim();
    if (v && !hre.ethers.isAddress(v)) throw new Error(`${name} không phải địa chỉ ví hợp lệ: ${v}`);
    return v ? hre.ethers.getAddress(v) : "";
  };

  const multisig = env("ADMIN_MULTISIG_ADDRESS");
  const operator = env("OPERATOR_ADDRESS");
  const guardian = env("GUARDIAN_ADDRESS");
  const manufacturer = env("MANUFACTURER_ADDRESS") || (isLocal && signers[1] ? signers[1].address : "");
  const distributor = env("DISTRIBUTOR_ADDRESS") || (isLocal && signers[2] ? signers[2].address : "");

  async function grant(roleName, who) {
    if (!who) return;
    if (await contract.hasRole(ROLE[roleName], who)) return;
    await (await contract.grantRole(ROLE[roleName], who)).wait();
    console.log(`  ✓ Cấp ${roleName}_ROLE cho ${who}`);
  }

  console.log("\nCấp quyền:");
  await grant("MANUFACTURER", manufacturer);
  await grant("DISTRIBUTOR", distributor);
  await grant("OPERATOR", operator);
  await grant("GUARDIAN", guardian);
  await grant("ADMIN", multisig);

  if (multisig) {
    // Ví deploy chỉ là "người dựng nhà" — dựng xong phải trả chìa khoá.
    // Thứ tự quan trọng: từ bỏ OPERATOR/GUARDIAN trước, ADMIN cuối cùng.
    console.log("\nVí deploy từ bỏ quyền (đã có multisig giữ admin):");
    for (const roleName of ["OPERATOR", "GUARDIAN", "ADMIN"]) {
      // Giữ lại OPERATOR/GUARDIAN nếu không có ví nào khác được chỉ định,
      // để không ai khoá mất chức năng đó. Multisig có thể cấp lại sau.
      if (roleName === "OPERATOR" && !operator) {
        console.log("  ! Giữ OPERATOR_ROLE cho ví deploy vì chưa đặt OPERATOR_ADDRESS");
        continue;
      }
      if (roleName === "GUARDIAN" && !guardian) {
        console.log("  ! Giữ GUARDIAN_ROLE cho ví deploy vì chưa đặt GUARDIAN_ADDRESS");
        continue;
      }
      await (await contract.renounceRole(ROLE[roleName], deployer.address)).wait();
      console.log(`  ✓ Ví deploy đã từ bỏ ${roleName === "ADMIN" ? "DEFAULT_ADMIN" : roleName}_ROLE`);
    }
  } else if (!isLocal) {
    console.log(
      "\n⚠ CẢNH BÁO: chưa đặt ADMIN_MULTISIG_ADDRESS — ví deploy đang giữ DEFAULT_ADMIN_ROLE.\n" +
        "  Lộ private key ví này = mất toàn quyền hệ thống. Nên tạo Safe tại https://app.safe.global\n" +
        "  rồi deploy lại với ADMIN_MULTISIG_ADDRESS."
    );
  }

  console.log("\nTóm tắt quyền hiện tại:");
  const check = [
    ["Ví deploy", deployer.address],
    ["Multisig", multisig],
    ["Operator", operator],
    ["Guardian", guardian],
    ["Nhà sản xuất", manufacturer],
    ["Phân phối", distributor],
  ];
  for (const [label, who] of check) {
    if (!who) continue;
    const roles = [];
    for (const [name, hash] of Object.entries(ROLE)) {
      if (await contract.hasRole(hash, who)) roles.push(name);
    }
    console.log(`  ${label.padEnd(13)} ${who}  →  ${roles.join(", ") || "(không có quyền)"}`);
  }

  // Ghi địa chỉ + ABI ra backend để backend tự động đọc khi khởi động
  const artifact = await hre.artifacts.readArtifact("ProductNFT");
  const outDir = path.join(__dirname, "..", "..", "backend", "src", "data");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "contract.json"),
    JSON.stringify({ address, abi: artifact.abi }, null, 2)
  );
  console.log("\nĐã ghi địa chỉ + ABI vào backend/src/data/contract.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
