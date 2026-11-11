const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

/** LIM-01..06: giới hạn số sản phẩm mỗi ví nhà sản xuất mint trong 1 ngày */
describe("ProductNFT — Giới hạn mint mỗi ngày", function () {
  let nft, admin, maker, maker2, stranger;
  const mint = (who) => nft.connect(who).mintProduct(who.address, "ipfs://x", "SKU", "", "");

  beforeEach(async function () {
    [admin, maker, maker2, stranger] = await ethers.getSigners();
    nft = await (await ethers.getContractFactory("ProductNFT")).deploy();
    const M = await nft.MANUFACTURER_ROLE();
    await nft.grantRole(M, maker.address);
    await nft.grantRole(M, maker2.address);
  });

  it("LIM-01: mặc định 50/ngày, đếm đúng số đã mint", async function () {
    expect(await nft.dailyMintLimit()).to.equal(50n);
    await mint(maker);
    await mint(maker);
    expect(await nft.mintedToday(maker.address)).to.equal(2n);
  });

  it("LIM-02: vượt giới hạn thì bị chặn (ví bị lộ không mint hàng loạt được)", async function () {
    await nft.setDailyMintLimit(3);
    for (let i = 0; i < 3; i++) await mint(maker);
    await expect(mint(maker)).to.be.revertedWith("Vuot gioi han mint trong ngay");
    expect(await nft.totalMinted()).to.equal(3n);
  });

  it("LIM-03: giới hạn tính RIÊNG từng ví", async function () {
    await nft.setDailyMintLimit(1);
    await mint(maker);
    await expect(mint(maker)).to.be.reverted;
    await mint(maker2); // ví khác vẫn mint được
  });

  it("LIM-04: sang ngày mới thì được mint lại", async function () {
    await nft.setDailyMintLimit(1);
    await mint(maker);
    await expect(mint(maker)).to.be.reverted;
    await time.increase(24 * 60 * 60);
    expect(await nft.mintedToday(maker.address)).to.equal(0n);
    await mint(maker);
  });

  it("LIM-05: chỉ admin (multisig) đổi được giới hạn; nhà sản xuất / người lạ thì không", async function () {
    await expect(nft.connect(maker).setDailyMintLimit(1000)).to.be.reverted;
    await expect(nft.connect(stranger).setDailyMintLimit(1000)).to.be.reverted;
    await expect(nft.setDailyMintLimit(7)).to.emit(nft, "DailyMintLimitChanged").withArgs(50n, 7n, admin.address);
  });

  it("LIM-06: không đặt được giới hạn 0 hoặc quá lớn", async function () {
    await expect(nft.setDailyMintLimit(0)).to.be.revertedWith("Gioi han khong hop le");
    await expect(nft.setDailyMintLimit(10001)).to.be.revertedWith("Gioi han khong hop le");
  });
});
