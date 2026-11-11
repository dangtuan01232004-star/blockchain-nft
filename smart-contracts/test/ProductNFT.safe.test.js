const { expect } = require("chai");
const { ethers } = require("hardhat");
const { transferAdmin } = require("../scripts/lib/adminTransfer");

/**
 * SAFE-01..08: chuyển quyền admin sang ví multisig 2/3 và chứng minh
 * kẻ tấn công cầm private key ví cũ (ví A) KHÔNG còn leo thang được.
 */
describe("ProductNFT — Admin bằng Safe multisig 2/3", function () {
  let nft, safe, A, s1, s2, s3, attacker, ADMIN, OPERATOR, GUARDIAN;
  const quiet = () => {};

  // đề xuất + ký + thực thi; trả về id đề xuất
  let nextId = 0;
  async function safeTx(signers, fn, args) {
    const data = nft.interface.encodeFunctionData(fn, args);
    await safe.connect(signers[0]).propose(await nft.getAddress(), data);
    const id = nextId++;
    for (const s of signers.slice(1)) await safe.connect(s).approve(id);
    return id;
  }

  beforeEach(async function () {
    [A, s1, s2, s3, attacker] = await ethers.getSigners();
    nft = await (await ethers.getContractFactory("ProductNFT")).deploy();
    safe = await (await ethers.getContractFactory("MockSafe2of3")).deploy([s1.address, s2.address, s3.address]);
    ADMIN = await nft.DEFAULT_ADMIN_ROLE();
    OPERATOR = await nft.OPERATOR_ROLE();
    GUARDIAN = await nft.GUARDIAN_ROLE();
    nextId = 0;
  });

  it("SAFE-01: từ chối địa chỉ không phải contract (gõ nhầm ví thường)", async function () {
    await expect(
      transferAdmin({ ethers, contract: nft, signer: A, safeAddress: attacker.address, log: quiet })
    ).to.be.rejectedWith(/KHÔNG phải contract/);
    expect(await nft.hasRole(ADMIN, attacker.address)).to.equal(false);
  });

  it("SAFE-02: bước 1 cấp admin cho Safe, ví A vẫn giữ admin (còn đường lui)", async function () {
    const r = await transferAdmin({ ethers, contract: nft, signer: A, safeAddress: await safe.getAddress(), log: quiet });
    expect(r.granted).to.equal(true);
    expect(await nft.hasRole(ADMIN, await safe.getAddress())).to.equal(true);
    expect(await nft.hasRole(ADMIN, A.address)).to.equal(true);
  });

  it("SAFE-03: bước 2 ví A từ bỏ admin, vẫn giữ OPERATOR/GUARDIAN cho việc hằng ngày", async function () {
    const safeAddr = await safe.getAddress();
    await transferAdmin({ ethers, contract: nft, signer: A, safeAddress: safeAddr, log: quiet });
    const r = await transferAdmin({ ethers, contract: nft, signer: A, safeAddress: safeAddr, renounce: true, log: quiet });
    expect(r.renounced).to.equal(true);
    expect(await nft.hasRole(ADMIN, A.address)).to.equal(false);
    expect(await nft.hasRole(OPERATOR, A.address)).to.equal(true);
    expect(await nft.hasRole(GUARDIAN, A.address)).to.equal(true);
  });

  describe("sau khi chuyển xong — kẻ tấn công có private key ví A", function () {
    beforeEach(async function () {
      const safeAddr = await safe.getAddress();
      await transferAdmin({ ethers, contract: nft, signer: A, safeAddress: safeAddr, renounce: true, log: quiet });
    });

    it("SAFE-04: ví A KHÔNG tự cấp lại admin / cấp admin cho ví hacker được", async function () {
      await expect(nft.connect(A).grantRole(ADMIN, A.address)).to.be.reverted;
      await expect(nft.connect(A).grantRole(ADMIN, attacker.address)).to.be.reverted;
      await expect(nft.connect(A).grantRole(GUARDIAN, attacker.address)).to.be.reverted;
    });

    it("SAFE-05: ví A dừng khẩn cấp được (Guardian) nhưng KHÔNG tự mở lại / gỡ cờ được", async function () {
      await nft.connect(A).pause();
      await expect(nft.connect(A).unpause()).to.be.reverted;
      await expect(nft.connect(A).clearCompromised(attacker.address)).to.be.reverted;
    });

    it("SAFE-06: Safe chỉ 1 chữ ký thì KHÔNG thực thi được", async function () {
      await nft.connect(A).pause();
      const id = await safeTx([s1], "unpause", []);
      await expect(safe.execute(id)).to.be.revertedWith("Chua du chu ky");
      expect(await nft.paused()).to.equal(true);
    });

    it("SAFE-07: Safe đủ 2/3 chữ ký thì mở lại hệ thống được", async function () {
      await nft.connect(A).pause();
      const id = await safeTx([s1, s3], "unpause", []);
      await safe.execute(id);
      expect(await nft.paused()).to.equal(false);
    });

    it("SAFE-08: ví A bị lộ → Safe (2/3) tước OPERATOR + GUARDIAN của ví A", async function () {
      await safe.execute(await safeTx([s1, s2], "revokeRole", [OPERATOR, A.address]));
      await safe.execute(await safeTx([s2, s3], "revokeRole", [GUARDIAN, A.address]));
      expect(await nft.hasRole(OPERATOR, A.address)).to.equal(false);
      expect(await nft.hasRole(GUARDIAN, A.address)).to.equal(false);
      await expect(nft.connect(A).pause()).to.be.reverted;
    });
  });
});
