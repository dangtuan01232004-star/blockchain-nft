const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ProductNFT", function () {
  let contract, admin, manufacturer, distributor, consumer;

  beforeEach(async function () {
    [admin, manufacturer, distributor, consumer] = await ethers.getSigners();

    const ProductNFT = await ethers.getContractFactory("ProductNFT");
    contract = await ProductNFT.deploy();
    await contract.waitForDeployment();

    const MANUFACTURER_ROLE = await contract.MANUFACTURER_ROLE();
    const DISTRIBUTOR_ROLE = await contract.DISTRIBUTOR_ROLE();
    await contract.grantRole(MANUFACTURER_ROLE, manufacturer.address);
    await contract.grantRole(DISTRIBUTOR_ROLE, distributor.address);
  });

  it("Nhà sản xuất mint NFT sản phẩm thành công", async function () {
    const tx = await contract
      .connect(manufacturer)
      .mintProduct(manufacturer.address, "ipfs://fake-cid/metadata.json", "SKU-001", "", "");
    await tx.wait();

    const [owner, uri, code, authentic, steps] = await contract.verifyProduct(0);
    expect(owner).to.equal(manufacturer.address);
    expect(uri).to.equal("ipfs://fake-cid/metadata.json");
    expect(code).to.equal("SKU-001");
    expect(authentic).to.equal(true);
    expect(steps).to.equal(1n);
  });

  it("Người không có MANUFACTURER_ROLE không thể mint", async function () {
    await expect(
      contract.connect(consumer).mintProduct(consumer.address, "ipfs://x", "SKU-002", "", "")
    ).to.be.reverted;
  });

  it("Chuyển giao chuỗi cung ứng ghi nhận đúng lịch sử", async function () {
    await contract.connect(manufacturer).mintProduct(manufacturer.address, "ipfs://x", "SKU-003", "", "");

    await contract
      .connect(manufacturer)
      .transferCustody(0, distributor.address, "DISTRIBUTOR", "Kho Hà Nội", "SHIPPED", "", "");

    await contract
      .connect(distributor)
      .transferCustody(0, consumer.address, "CONSUMER", "Cửa hàng bán lẻ", "SOLD", "", "");

    const history = await contract.getHistory(0);
    expect(history.length).to.equal(3); // MINTED + SHIPPED + SOLD

    const [owner] = await contract.verifyProduct(0);
    expect(owner).to.equal(consumer.address);
  });

  it("Admin thu hồi xác thực khi phát hiện gian lận", async function () {
    await contract.connect(manufacturer).mintProduct(manufacturer.address, "ipfs://x", "SKU-004", "", "");
    await contract.connect(admin).revokeAuthenticity(0, "Phat hien hang gia bao cao boi nguoi dung");

    const [, , , authentic] = await contract.verifyProduct(0);
    expect(authentic).to.equal(false);
  });

  it("Sản phẩm không tồn tại phải báo lỗi khi xác thực (nghi ngờ hàng giả)", async function () {
    await expect(contract.verifyProduct(999)).to.be.reverted;
  });
});
