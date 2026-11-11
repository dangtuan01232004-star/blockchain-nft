# Chuyển quyền ADMIN sang ví Safe multisig 2/3

Mục tiêu: quyền cao nhất của contract (`DEFAULT_ADMIN_ROLE`) do **ví Safe** giữ.
Mọi thao tác admin cần **2 trong 3 chủ** ký. Hacker lấy được 1 ví (kể cả ví A) cũng không leo lên admin được.

- **Không cần deploy lại.** Sản phẩm đã mint vẫn giữ nguyên.
- Sau khi xong, **ví A vẫn dùng như cũ** cho việc hằng ngày: duyệt đối tác (OPERATOR) và dừng khẩn cấp (GUARDIAN).
- Chỉ những việc cấp cao mới phải đi qua Safe: mở lại hệ thống, gỡ cờ ví, cấp hoặc thu hồi OPERATOR/GUARDIAN.

---

## Bước 0 — Chuẩn bị 3 ví chủ Safe

> Ví A đã từng bị lộ private key trong ảnh chụp màn hình, nên **không dùng ví A làm chủ Safe**.

Trong MetaMask, bấm vào tên tài khoản → **Add account** để tạo 3 tài khoản mới:

| Tên | Ở đâu | Ghi chú |
|---|---|---|
| Safe 1 | MetaMask trên máy tính | Cần ít Sepolia ETH để trả gas tạo Safe |
| Safe 2 | MetaMask trên máy tính (hoặc trình duyệt khác) | |
| Safe 3 | MetaMask trên **điện thoại** | Ví dự phòng, cất riêng |

Từ ví A, chuyển khoảng **0.05 Sepolia ETH** sang **Safe 1** và **0.02** sang **Safe 2**.
Ký giao dịch Safe thì không tốn gas. Chỉ người tạo Safe và người bấm thực thi mới trả gas.

> Thực tế, 3 ví này phải nằm ở **3 người hoặc 3 thiết bị khác nhau**. Khi demo đồ án thì để chung một máy cũng được, nhưng hãy nói rõ điều này trong báo cáo.

## Bước 1 — Tạo Safe

1. Vào **https://app.safe.global**, bấm **Connect wallet** và chọn MetaMask, tài khoản **Safe 1**.
2. Góc trên chọn mạng **Sepolia**.
3. Bấm **Create account**, đặt tên `NFTTrace Admin`.
4. Thêm **3 chủ (Signers)**: dán địa chỉ Safe 1, Safe 2, Safe 3.
5. Mục **Threshold** chọn **2 out of 3**.
6. Bấm **Create** và xác nhận giao dịch trong MetaMask.
7. Copy địa chỉ Safe. Địa chỉ hiện dạng `sep:0xABC...`, chỉ lấy phần `0xABC...` (bỏ chữ `sep:`).

## Bước 2 — Cấp admin cho Safe (ví A vẫn giữ admin, còn đường lui)

Mở file `smart-contracts/.env` và thêm dòng:

```
ADMIN_MULTISIG_ADDRESS=0x...địa chỉ Safe...
```

`PRIVATE_KEY` vẫn là ví A, giữ nguyên như lúc deploy. Sau đó trong Git Bash chạy:

```
cd smart-contracts
npx hardhat run scripts/transfer-admin-to-safe.js --network sepolia
```

Kết quả phải có dòng `Safe 0x...: ngưỡng 2/3` và `Safe giữ ADMIN: CÓ ✓`.

Script **từ chối chạy** khi:
- địa chỉ dán vào là ví thường (gõ nhầm) hoặc là Safe trên sai mạng,
- ngưỡng của Safe nhỏ hơn 2.

## Bước 3 — Thử Safe thật sự hoạt động (đây cũng là phần demo)

1. Vào trang **admin.html**, kết nối **ví A**, bấm **⏸ Dừng khẩn cấp** (quyền GUARDIAN).
2. Vào **app.safe.global**, mở Safe `NFTTrace Admin`, chọn **New transaction** → **Transaction Builder**.
3. Ô **Enter Address**: dán địa chỉ contract ProductNFT. Địa chỉ này có trong `backend/src/data/contract.json`, trường `address`.
4. Ô **Enter ABI**: mở file `smart-contracts/abi/ProductNFT.abi.json`, copy toàn bộ nội dung và dán vào.
5. Mục **Contract Method Selector** chọn `unpause`, bấm **Add transaction** → **Create Batch** → **Send Batch**. Ký bằng **Safe 1**. Lúc này giao dịch có **1/2 chữ ký** và **chưa chạy**.
6. Đổi MetaMask sang **Safe 2** (hoặc mở app Safe trên điện thoại bằng Safe 3). Vào **Transactions** → **Queue**, bấm **Confirm**, rồi bấm **Execute**.
7. Quay lại trang admin: hệ thống đã chạy lại. Như vậy đã chứng minh **cần 2/3 chữ ký mới mở lại được**.

## Bước 4 — Ví A từ bỏ admin (KHÔNG hoàn tác được)

Chỉ làm bước này khi Bước 3 đã chạy thành công:

```
RENOUNCE=yes npx hardhat run scripts/transfer-admin-to-safe.js --network sepolia
```

Kết quả phải có dòng `Ví 0x… giữ ADMIN: KHÔNG ✓`.

Nếu dùng PowerShell thay vì Git Bash, chạy: `$env:RENOUNCE="yes"; npx hardhat run scripts/transfer-admin-to-safe.js --network sepolia`

## Sau khi xong

| Việc | Ai làm |
|---|---|
| Cấp/thu hồi quyền nhà sản xuất, nhà phân phối | Ví A (OPERATOR), trên trang admin như cũ |
| Dừng khẩn cấp, gắn cờ ví bị hack, thu hồi sản phẩm | Ví A (GUARDIAN), trên trang admin như cũ |
| **Mở lại hệ thống, gỡ cờ ví** | **Safe 2/3**. Trang admin sẽ báo "hãy thực hiện trong app.safe.global" |
| **Cấp/thu hồi OPERATOR, GUARDIAN; cấp admin** | **Safe 2/3**: Transaction Builder → `grantRole` / `revokeRole` |

**Nếu ví A bị hack:** hacker chỉ còn làm được những việc của OPERATOR/GUARDIAN. Khi đó dùng Safe (2/3) gọi `revokeRole(OPERATOR_ROLE, ví A)` và `revokeRole(GUARDIAN_ROLE, ví A)` để tước luôn hai quyền này. Mã role lấy bằng cách gọi hàm `OPERATOR_ROLE()` / `GUARDIAN_ROLE()` ở tab Read trên Etherscan, hoặc xem phần in ra khi chạy deploy.

## Kiểm thử tự động

```
npx hardhat test test/ProductNFT.safe.test.js
```

Có 8 test, mã SAFE-01 đến SAFE-08. Các test chứng minh:
- ví A sau khi từ bỏ admin **không tự cấp lại quyền** được;
- Safe chỉ có 1 chữ ký thì **không thực thi** được;
- Safe đủ 2/3 chữ ký thì mở lại được hệ thống và tước được quyền của ví A.
