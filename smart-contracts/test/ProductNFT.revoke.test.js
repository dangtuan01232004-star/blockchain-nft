const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ProductNFT - thu hồi xác thực", function () {
  let contract, admin, manufacturer, distributor, other;

  beforeEach(async function () {
    [admin, manufacturer, distributor, other] = await ethers.getSigners();

    const ProductNFT = await ethers.getContractFactory("ProductNFT");
    contract = await ProductNFT.deploy();
    await contract.waitForDeployment();

    const MANUFACTURER_ROLE = await contract.MANUFACTURER_ROLE();
    const DISTRIBUTOR_ROLE = await contract.DISTRIBUTOR_ROLE();
    await contract.grantRole(MANUFACTURER_ROLE, manufacturer.address);
    await contract.grantRole(DISTRIBUTOR_ROLE, distributor.address);

    await contract
      .connect(manufacturer)
      .mintProduct(manufacturer.address, "ipfs://fake-cid/metadata.json", "SKU-REVOKE-001", "", "");
  });

  it("TC-06: Admin thu hồi thành công, phát sự kiện và verifyProduct trả authentic=false", async function () {
    const reason = "Phat hien hang gia";
    const tx = await contract.connect(admin).revokeAuthenticity(0, reason);
    const receipt = await tx.wait();

    await expect(tx)
      .to.emit(contract, "ProductRevoked")
      .withArgs(0, reason);

    const [, , , authentic] = await contract.verifyProduct(0);
    expect(authentic).to.equal(false);
    console.log("TC-06 gasUsed revokeAuthenticity:", receipt.gasUsed.toString());
  });

  it("TC-07 / TC-S3: Không thể chuyển giao token đã bị thu hồi", async function () {
    await contract.connect(admin).revokeAuthenticity(0, "Phat hien hang gia");

    await expect(
      contract
        .connect(manufacturer)
        .transferCustody(0, distributor.address, "DISTRIBUTOR", "Kho Ha Noi", "SHIPPED", "", "")
    ).to.be.revertedWith("San pham da bi thu hoi xac thuc");
  });

  it("TC-S4: Manufacturer, Distributor và ví bất kỳ không thể thu hồi xác thực", async function () {
    for (const account of [manufacturer, distributor, other]) {
      await expect(
        contract.connect(account).revokeAuthenticity(0, "Khong co quyen")
      ).to.be.reverted;
    }
  });

  it("Admin thu hồi token không tồn tại thì revert", async function () {
    await expect(
      contract.connect(admin).revokeAuthenticity(999, "Token khong ton tai")
    ).to.be.revertedWith("Token khong ton tai");
  });

  it("Admin thu hồi lần hai vẫn thành công và phát lại ProductRevoked", async function () {
    const firstReason = "Lan thu hoi dau";
    const secondReason = "Lan thu hoi thu hai";
    await contract.connect(admin).revokeAuthenticity(0, firstReason);

    await expect(contract.connect(admin).revokeAuthenticity(0, secondReason))
      .to.emit(contract, "ProductRevoked")
      .withArgs(0, secondReason);

    expect(await contract.isRevoked(0)).to.equal(true);
    const [, , , authentic] = await contract.verifyProduct(0);
    expect(authentic).to.equal(false);
  });
});
