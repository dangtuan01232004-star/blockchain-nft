const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { signMintAuth } = require("../../backend/src/services/mintAuthSign");

/**
 * AUTH-01..10: MINT HAI CHỮ KÝ — ví nhà sản xuất + khoá uỷ quyền của hệ thống.
 * Kịch bản chính: hacker có private key ví nhà sản xuất nhưng không qua được
 * bước xác thực lại (passkey / 2FA) nên không có chữ ký thứ hai.
 */
describe("ProductNFT — Mint hai chữ ký (chống ví nhà sản xuất bị lộ)", function () {
  let nft, admin, maker, hacker, authorizer, fakeAuthorizer, chainId;
  const P = { tokenURI: "ipfs://meta", productCode: "SKU-1", photoURI: "ipfs://photo", gps: "21.0,105.8" };

  async function auth(over = {}) {
    const deadline = over.deadline ?? (await time.latest()) + 600;
    const nonce = over.nonce ?? ethers.hexlify(ethers.randomBytes(32));
    const signer = over.signer ?? authorizer;
    const sig = await signMintAuth(signer, {
      chainId,
      contract: await nft.getAddress(),
      minter: over.minter ?? maker.address,
      to: over.to ?? maker.address,
      ...P,
      ...(over.p || {}),
      nonce,
      deadline,
    });
    return { nonce, deadline, sig };
  }
  const mintAuth = (who, a, p = P, to) =>
    nft.connect(who).mintProductAuthorized(to ?? who.address, p.tokenURI, p.productCode, p.photoURI, p.gps, a.nonce, a.deadline, a.sig);

  beforeEach(async function () {
    [admin, maker, hacker] = await ethers.getSigners();
    authorizer = ethers.Wallet.createRandom();
    fakeAuthorizer = ethers.Wallet.createRandom();
    chainId = Number((await ethers.provider.getNetwork()).chainId);
    nft = await (await ethers.getContractFactory("ProductNFT")).deploy();
    await nft.grantRole(await nft.MANUFACTURER_ROLE(), maker.address);
    await nft.setMintAuthorizer(authorizer.address);
  });

  it("AUTH-01: có đủ 2 chữ ký thì mint được", async function () {
    await mintAuth(maker, await auth());
    expect(await nft.totalMinted()).to.equal(1n);
  });

  it("AUTH-02: ví bị lộ gọi mint thường (không chữ ký 2) → BỊ CHẶN", async function () {
    await expect(nft.connect(maker).mintProduct(maker.address, "ipfs://x", "SKU", "", "")).to.be.revertedWith("Can chu ky uy quyen mint");
  });

  it("AUTH-03: hacker tự ký bằng khoá giả → BỊ CHẶN", async function () {
    await expect(mintAuth(maker, await auth({ signer: fakeAuthorizer }))).to.be.revertedWith("Chu ky uy quyen khong hop le");
  });

  it("AUTH-04: dùng lại chữ ký cũ (replay) → BỊ CHẶN", async function () {
    const a = await auth();
    await mintAuth(maker, a);
    await expect(mintAuth(maker, a)).to.be.revertedWith("Chu ky uy quyen da dung");
  });

  it("AUTH-05: chữ ký quá hạn → BỊ CHẶN", async function () {
    const a = await auth();
    await time.increase(601);
    await expect(mintAuth(maker, a)).to.be.revertedWith("Chu ky uy quyen het han");
  });

  it("AUTH-06: lấy chữ ký hợp lệ nhưng sửa nội dung (metadata giả) → BỊ CHẶN", async function () {
    const a = await auth();
    await expect(mintAuth(maker, a, { ...P, tokenURI: "ipfs://HANG-GIA" })).to.be.revertedWith("Chu ky uy quyen khong hop le");
    await expect(mintAuth(maker, a, { ...P, productCode: "SKU-KHAC" })).to.be.revertedWith("Chu ky uy quyen khong hop le");
  });

  it("AUTH-07: chữ ký cấp cho ví A, ví khác dùng → BỊ CHẶN", async function () {
    await nft.grantRole(await nft.MANUFACTURER_ROLE(), hacker.address);
    await expect(mintAuth(hacker, await auth())).to.be.revertedWith("Chu ky uy quyen khong hop le");
  });

  it("AUTH-08: đổi ví nhận NFT so với chữ ký → BỊ CHẶN", async function () {
    await expect(mintAuth(maker, await auth(), P, hacker.address)).to.be.revertedWith("Chu ky uy quyen khong hop le");
  });

  it("AUTH-09: chỉ admin (multisig) đổi / tắt được khoá uỷ quyền", async function () {
    await expect(nft.connect(maker).setMintAuthorizer(ethers.ZeroAddress)).to.be.reverted;
    await expect(nft.connect(hacker).setMintAuthorizer(hacker.address)).to.be.reverted;
    await expect(nft.setMintAuthorizer(fakeAuthorizer.address))
      .to.emit(nft, "MintAuthorizerChanged")
      .withArgs(authorizer.address, fakeAuthorizer.address, admin.address);
  });

  it("AUTH-10: chữ ký của contract khác / mạng khác không dùng được", async function () {
    const other = await (await ethers.getContractFactory("ProductNFT")).deploy();
    const deadline = (await time.latest()) + 600;
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const sig = await signMintAuth(authorizer, { chainId, contract: await other.getAddress(), minter: maker.address, to: maker.address, ...P, nonce, deadline });
    await expect(mintAuth(maker, { nonce, deadline, sig })).to.be.revertedWith("Chu ky uy quyen khong hop le");
  });
});
