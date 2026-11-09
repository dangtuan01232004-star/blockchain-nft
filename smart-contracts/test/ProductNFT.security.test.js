const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Bộ test cho mô hình bảo mật nhiều tầng:
 *  - tách quyền ADMIN / OPERATOR / GUARDIAN, chống leo thang đặc quyền
 *  - dừng khẩn cấp (pause)
 *  - gắn cờ ví bị xâm phạm và khoanh vùng sản phẩm nghi vấn
 *  - chặn chuyển token ngoài luồng transferCustody
 */
describe("ProductNFT - bảo mật", function () {
  let contract, deployer, multisig, operator, guardian, manufacturer, distributor, attacker, consumer;
  let ROLE;

  beforeEach(async function () {
    [deployer, multisig, operator, guardian, manufacturer, distributor, attacker, consumer] =
      await ethers.getSigners();

    const ProductNFT = await ethers.getContractFactory("ProductNFT");
    contract = await ProductNFT.deploy();
    await contract.waitForDeployment();

    ROLE = {
      ADMIN: await contract.DEFAULT_ADMIN_ROLE(),
      OPERATOR: await contract.OPERATOR_ROLE(),
      GUARDIAN: await contract.GUARDIAN_ROLE(),
      MANUFACTURER: await contract.MANUFACTURER_ROLE(),
      DISTRIBUTOR: await contract.DISTRIBUTOR_ROLE(),
    };

    // Mô phỏng đúng quy trình deploy.js khi có multisig
    await contract.grantRole(ROLE.ADMIN, multisig.address);
    await contract.grantRole(ROLE.OPERATOR, operator.address);
    await contract.grantRole(ROLE.GUARDIAN, guardian.address);
    await contract.grantRole(ROLE.MANUFACTURER, manufacturer.address);
    await contract.grantRole(ROLE.DISTRIBUTOR, distributor.address);
    await contract.renounceRole(ROLE.OPERATOR, deployer.address);
    await contract.renounceRole(ROLE.GUARDIAN, deployer.address);
    await contract.renounceRole(ROLE.ADMIN, deployer.address);
  });

  async function mint(sku = "SKU-SEC") {
    await contract.connect(manufacturer).mintProduct(manufacturer.address, "ipfs://x", sku, "", "");
    return (await contract.totalMinted()) - 1n;
  }

  describe("Tách quyền & chống leo thang đặc quyền", function () {
    it("SEC-01: ví deploy không còn quyền gì sau khi bàn giao cho multisig", async function () {
      for (const r of Object.values(ROLE)) {
        expect(await contract.hasRole(r, deployer.address)).to.equal(false);
      }
      await expect(contract.connect(deployer).grantRole(ROLE.MANUFACTURER, attacker.address)).to.be.reverted;
    });

    it("SEC-02: ví deploy không có quyền mint ngay từ đầu (tách quản trị khỏi sản xuất)", async function () {
      const Fresh = await ethers.getContractFactory("ProductNFT");
      const fresh = await Fresh.deploy();
      expect(await fresh.hasRole(ROLE.MANUFACTURER, deployer.address)).to.equal(false);
    });

    it("SEC-03: nhà sản xuất bị hack không tự cấp được quyền nào (kể cả admin)", async function () {
      for (const r of Object.values(ROLE)) {
        await expect(contract.connect(manufacturer).grantRole(r, attacker.address)).to.be.reverted;
      }
    });

    it("SEC-04: operator cấp được NSX/phân phối nhưng KHÔNG leo lên admin/guardian/operator", async function () {
      await contract.connect(operator).grantRole(ROLE.MANUFACTURER, consumer.address);
      expect(await contract.hasRole(ROLE.MANUFACTURER, consumer.address)).to.equal(true);

      for (const r of [ROLE.ADMIN, ROLE.GUARDIAN, ROLE.OPERATOR]) {
        await expect(contract.connect(operator).grantRole(r, operator.address)).to.be.reverted;
      }
    });

    it("SEC-05: guardian không cấp được quyền cho ai và không mở lại được hệ thống", async function () {
      for (const r of Object.values(ROLE)) {
        await expect(contract.connect(guardian).grantRole(r, attacker.address)).to.be.reverted;
      }
      await contract.connect(guardian).pause();
      await expect(contract.connect(guardian).unpause()).to.be.reverted;
    });

    it("SEC-06: guardian không gắn cờ được ví admin (multisig)", async function () {
      await expect(contract.connect(guardian).flagCompromised(multisig.address, 0)).to.be.revertedWith(
        "Khong the gan co admin"
      );
    });
  });

  describe("Dừng khẩn cấp", function () {
    it("SEC-07: khi pause, không mint và không chuyển giao được; admin unpause thì chạy lại", async function () {
      const id = await mint();
      await expect(contract.connect(guardian).pause()).to.emit(contract, "Paused");

      await expect(
        contract.connect(manufacturer).mintProduct(manufacturer.address, "ipfs://y", "SKU-P", "", "")
      ).to.be.revertedWithCustomError(contract, "EnforcedPause");
      await expect(
        contract.connect(manufacturer).transferCustody(id, distributor.address, "DISTRIBUTOR", "Kho", "SHIPPED", "", "")
      ).to.be.revertedWithCustomError(contract, "EnforcedPause");

      await contract.connect(multisig).unpause();
      await contract
        .connect(manufacturer)
        .transferCustody(id, distributor.address, "DISTRIBUTOR", "Kho", "SHIPPED", "", "");
      expect(await contract.ownerOf(id)).to.equal(distributor.address);
    });

    it("SEC-08: vẫn thu hồi xác thực được trong lúc hệ thống đang dừng", async function () {
      const id = await mint();
      await contract.connect(guardian).pause();
      await contract.connect(guardian).revokeAuthenticity(id, "Nghi gia trong luc su co");
      expect(await contract.isRevoked(id)).to.equal(true);
    });

    it("SEC-09: người lạ không pause được", async function () {
      await expect(contract.connect(attacker).pause()).to.be.reverted;
    });
  });

  describe("Ví bị xâm phạm", function () {
    it("SEC-10: flagCompromised tước quyền ngay và chặn mint tiếp", async function () {
      await expect(contract.connect(guardian).flagCompromised(manufacturer.address, 0)).to.emit(
        contract,
        "WalletCompromised"
      );
      expect(await contract.hasRole(ROLE.MANUFACTURER, manufacturer.address)).to.equal(false);
      await expect(
        contract.connect(manufacturer).mintProduct(manufacturer.address, "ipfs://z", "SKU-Z", "", "")
      ).to.be.reverted;
    });

    it("SEC-11: chỉ sản phẩm mint SAU thời điểm lộ khoá bị đánh dấu nghi vấn", async function () {
      const before = await mint("SKU-TRUOC");
      await time.increase(3600);
      const leakTime = await time.latest();
      await time.increase(10);
      const after = await mint("SKU-SAU");

      await contract.connect(guardian).flagCompromised(manufacturer.address, leakTime);

      const [suspectBefore] = await contract.securityStatus(before);
      const [suspectAfter, actor, since, stepIndex] = await contract.securityStatus(after);
      expect(suspectBefore).to.equal(false);
      expect(suspectAfter).to.equal(true);
      expect(actor).to.equal(manufacturer.address);
      expect(since).to.equal(BigInt(leakTime));
      expect(stepIndex).to.equal(0n);
    });

    it("SEC-12: sản phẩm thật bị ví phân phối đã hack chuyển giao cũng bị gắn nghi vấn", async function () {
      const id = await mint();
      await contract
        .connect(manufacturer)
        .transferCustody(id, distributor.address, "DISTRIBUTOR", "Kho", "SHIPPED", "", "");
      await contract.connect(guardian).flagCompromised(distributor.address, 0);
      // Bước chuyển giao xảy ra TRƯỚC khi lộ khoá → vẫn sạch
      expect((await contract.securityStatus(id))[0]).to.equal(false);

      // Lùi mốc lộ khoá về trước bước chuyển giao → nghi vấn
      const Fresh = await ethers.getContractFactory("ProductNFT");
      const c2 = await Fresh.deploy();
      await c2.grantRole(ROLE.MANUFACTURER, manufacturer.address);
      await c2.grantRole(ROLE.DISTRIBUTOR, distributor.address);
      await c2.connect(manufacturer).mintProduct(manufacturer.address, "ipfs://x", "SKU", "", "");
      const leak = await time.latest();
      await time.increase(5);
      await c2.connect(manufacturer).transferCustody(0, distributor.address, "D", "Kho", "SHIPPED", "", "");
      await c2.connect(distributor).transferCustody(0, attacker.address, "D", "?", "SOLD", "", "");
      await c2.flagCompromised(distributor.address, leak);
      const [suspect, actor, , stepIndex] = await c2.securityStatus(0);
      expect(suspect).to.equal(true);
      expect(actor).to.equal(distributor.address);
      expect(stepIndex).to.equal(2n); // bước distributor → attacker
    });

    it("SEC-13: gắn cờ lần 2 chỉ được lùi mốc sớm hơn, không đẩy muộn hơn để che giấu", async function () {
      await time.increase(1000);
      const t1 = (await time.latest()) - 500;
      await contract.connect(guardian).flagCompromised(manufacturer.address, t1);
      await contract.connect(guardian).flagCompromised(manufacturer.address, t1 + 400);
      expect(await contract.compromisedSince(manufacturer.address)).to.equal(BigInt(t1));
      await contract.connect(guardian).flagCompromised(manufacturer.address, t1 - 100);
      expect(await contract.compromisedSince(manufacturer.address)).to.equal(BigInt(t1 - 100));
    });

    it("SEC-14: chỉ admin gỡ cờ được, và gỡ cờ không tự cấp lại quyền", async function () {
      await contract.connect(guardian).flagCompromised(manufacturer.address, 0);
      await expect(contract.connect(guardian).clearCompromised(manufacturer.address)).to.be.reverted;
      await expect(contract.connect(multisig).clearCompromised(manufacturer.address)).to.emit(
        contract,
        "WalletCleared"
      );
      expect(await contract.compromisedSince(manufacturer.address)).to.equal(0n);
      expect(await contract.hasRole(ROLE.MANUFACTURER, manufacturer.address)).to.equal(false);
    });

    it("SEC-15: không gắn cờ được với mốc thời gian trong tương lai", async function () {
      const future = (await time.latest()) + 86400;
      await expect(contract.connect(guardian).flagCompromised(manufacturer.address, future)).to.be.revertedWith(
        "Thoi diem trong tuong lai"
      );
    });
  });

  describe("Chuyển giao chặt chẽ", function () {
    it("SEC-16: ví phân phối KHÔNG chuyển được token không thuộc về mình", async function () {
      const id = await mint();
      await expect(
        contract.connect(distributor).transferCustody(id, attacker.address, "DISTRIBUTOR", "Kho", "SHIPPED", "", "")
      ).to.be.revertedWith("Khong co quyen chuyen giao");
    });

    it("SEC-17: không chuyển được qua transferFrom/safeTransferFrom (lách lịch sử)", async function () {
      const id = await mint();
      await expect(
        contract.connect(manufacturer).transferFrom(manufacturer.address, attacker.address, id)
      ).to.be.revertedWith("Chi chuyen giao qua transferCustody");
      await expect(
        contract
          .connect(manufacturer)
          ["safeTransferFrom(address,address,uint256)"](manufacturer.address, attacker.address, id)
      ).to.be.revertedWith("Chi chuyen giao qua transferCustody");
    });

    it("SEC-18: không chuyển cho địa chỉ 0", async function () {
      const id = await mint();
      await expect(
        contract.connect(manufacturer).transferCustody(id, ethers.ZeroAddress, "X", "Kho", "SHIPPED", "", "")
      ).to.be.revertedWith("Nguoi nhan khong hop le");
    });
  });
});
