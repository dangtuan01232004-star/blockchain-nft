# Deploy lại contract: MINT HAI CHỮ KÝ + giới hạn mint + ghim cấu hình + xem trước giao dịch

## Lần nâng cấp này chặn được gì

| Kẻ tấn công có trong tay | Trước | Bây giờ |
|---|---|---|
| **Private key ví** nhà sản xuất | Mint hàng giả tuỳ ý | **Không mint được.** Contract đòi chữ ký thứ hai |
| **Ví + tài khoản + mật khẩu** | Mint tuỳ ý | **Không mint được.** Phải xác thực lại bằng **passkey/mã 2FA trên thiết bị của chính chủ**. Nhập sai thì admin nhận cảnh báo |
| Xin phép bằng **ví lạ** trên tài khoản nhà sản xuất | — | Bị chặn + **cảnh báo NGHIÊM TRỌNG** |
| Lấy được 1 chữ ký hợp lệ rồi **sửa thành hàng giả** / dùng lại | — | Bị chặn. Chữ ký gắn chặt nội dung, dùng 1 lần, hết hạn sau 10 phút |
| Có **đủ mọi thứ** (ví + mật khẩu + điện thoại 2FA) | — | Mỗi lần mint, **chủ tài khoản nhận Telegram** kèm nút khoá. Xin phép dồn dập thì **bị chặn** + cảnh báo. Mỗi ví có **giới hạn mint/ngày**. Guardian gắn cờ ví thì **mint bị chặn ngay** |
| Chiếm **backend**, đổi địa chỉ / ABI / mạng | Lừa admin ký lệnh khác | Trang báo động đỏ và **chặn mọi thao tác ký** |

Cách hoạt động của **mint hai chữ ký**:
1. Nhà sản xuất bấm *Phát hành* → hệ thống hỏi **passkey hoặc mã 6 số** (hiệu lực 5 phút).
2. Backend kiểm tra: đúng ví đã liên kết, ví không bị gắn cờ, còn quyền, không dồn dập. Đạt thì backend **ký giấy phép** bằng *khoá uỷ quyền* (chỉ nằm trên Render).
3. MetaMask ký lệnh mint **kèm giấy phép**. Smart contract kiểm tra cả 2 chữ ký. Thiếu một là từ chối.

> Khoá uỷ quyền **không có quyền gì** trên contract và không cần ETH. Lộ riêng khoá này thì vẫn phải có ví nhà sản xuất mới mint được. Chỉ Safe 2/3 mới đổi hoặc tắt được khoá này, và monitor báo động **NGHIÊM TRỌNG** nếu có ai đổi.

Contract thay đổi nên **phải deploy lại**. Các sản phẩm thử trên contract cũ sẽ không hiện nữa. **Safe giữ nguyên.**

---

## Bước 1 — Chép code, chạy test
Giải nén zip, chép đè vào project rồi chạy:
```
cd smart-contracts
npx hardhat test
```
Phải ra **52 passing**: thêm AUTH-01→10 cho mint hai chữ ký và LIM-01→06 cho giới hạn mint.
(Test AUTH dùng thư viện trong `backend/node_modules`; nếu báo thiếu module thì chạy `npm install` trong `backend`.)

## Bước 2 — Bật passkey hoặc 2FA cho tài khoản nhà sản xuất
Đăng nhập `aaaa` → **Tài khoản của tôi** → bật **passkey** (khuyên dùng) hoặc **xác thực 2 lớp**. Chưa bật thì sẽ **không phát hành được**.

## Bước 3 — Tạo khoá uỷ quyền mint
Trong Git Bash, ở thư mục `backend`:
```
node -e "const w=require('ethers').Wallet.createRandom();console.log('ADDRESS',w.address);console.log('KEY',w.privateKey)"
```
- **KEY** → Render → Environment → thêm biến `MINT_AUTHORIZER_KEY` → **Save**. **Không** ghi vào file nào, **không** gửi cho ai, **không** chụp ảnh.
- **ADDRESS** → dùng ở bước 5.

## Bước 4 — (Nên làm) Tạo ví Vận hành mới
MetaMask → **Add account** → đặt tên `Van hanh`, nạp khoảng 0.02 Sepolia ETH. Ví A (đã lộ) sẽ mất hết quyền sau khi deploy.

## Bước 5 — Sửa `smart-contracts/.env`
```
PRIVATE_KEY=...                    ← giữ ví A (chỉ deploy + trả gas, sau đó tự mất quyền)
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
ADMIN_MULTISIG_ADDRESS=0xAfC6Eb6657220a2dAcD412c44D58d1Addb6E1E5F
OPERATOR_ADDRESS=0x...             ← ví Van hanh
GUARDIAN_ADDRESS=0x...             ← ví Van hanh
MANUFACTURER_ADDRESS=0x26B5ACCf76cE8F068F4845c10082074F08FFA4c9
MINT_AUTHORIZER_ADDRESS=0x...      ← ADDRESS ở bước 3
DAILY_MINT_LIMIT=50
PUBLIC_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
```

## Bước 6 — Deploy
```
npx hardhat run scripts/deploy.js --network sepolia
```
Kiểm tra trong kết quả:
- `Mint hai chữ ký: BẬT — khoá uỷ quyền 0x…` (khớp ADDRESS ở bước 3)
- `Giới hạn mint: 50 sản phẩm / ngày / ví nhà sản xuất`
- Bảng tóm tắt: Multisig → ADMIN, Van hanh → OPERATOR + GUARDIAN, Ví deploy → (không có quyền)
- `Đã ghim cấu hình contract vào frontend/js/contract-pin.js`

## Bước 7 — Push
```
cd ..
git add smart-contracts backend frontend
git commit -m "Mint hai chu ky, gioi han mint, ghim cau hinh, xem truoc giao dich"
git push
```
> ⚠ Phải chạy Bước 6 **trước** khi push. Thiếu `contract-pin.js` thì trang admin sẽ chặn mọi thao tác ký.

## Bước 8 — Cấp lại quyền trên web
- `aaaa` (ví B) đã có quyền Sản xuất từ lúc deploy.
- Tài khoản khác: đăng nhập admin, MetaMask chọn ví **Van hanh** → **Quản lý người dùng** → **Cấp quyền**.

## Bước 9 — Thử và demo
1. Đăng nhập `aaaa`, ví B → **Phát hành NFT** → hộp **"Xác thực lại để phát hành sản phẩm"** hiện ra → passkey hoặc mã 6 số → hộp **xem trước** ghi *"✓ Chữ ký thứ hai của hệ thống"* → **Ký trong MetaMask**.
2. **Demo hacker chỉ có ví:** trên Etherscan, mở contract → **Write Contract** → kết nối ví B → gọi `mintProduct`. Giao dịch bị từ chối với lý do `Can chu ky uy quyen mint`.
3. **Demo hacker có tài khoản + ví nhưng không có điện thoại:** ở hộp xác thực, nhập bừa mã 6 số. Bị từ chối, và nhật ký bảo mật có cảnh báo *"ĐÚNG mật khẩu nhưng SAI mã xác thực…"*.

## Câu nói khi bảo vệ
*"Private key ví thôi là không đủ để mint. Smart contract đòi thêm chữ ký thứ hai, và hệ thống chỉ cấp chữ ký đó khi chính chủ vừa xác thực bằng passkey hoặc mã 2FA trên thiết bị của họ. Chữ ký gắn chặt với ví, nội dung sản phẩm, dùng một lần và hết hạn sau 10 phút. Kẻ tấn công có ví, thậm chí có cả mật khẩu tài khoản, vẫn không mint được, và mọi lần thử đều báo cho admin."*
