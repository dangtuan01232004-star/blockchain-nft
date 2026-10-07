# Con Dấu Số — Blockchain × NFT chống hàng giả & truy xuất nguồn gốc

Dự án hiện thực hóa đề cương đồ án tốt nghiệp **"Nghiên cứu triển khai giải
pháp sử dụng blockchain kết hợp với NFT nhằm chống hàng giả và truy xuất
nguồn gốc trong lĩnh vực thương mại điện tử"**. Mỗi sản phẩm được gắn một
NFT (chuẩn ERC-721) duy nhất, không thể sao chép; toàn bộ chuỗi cung ứng
(sản xuất → vận chuyển → bán ra) được ghi trên blockchain; người tiêu dùng
quét mã QR in trên sản phẩm để xác thực hàng chính hãng theo thời gian thực.

## 1. Kiến trúc hệ thống

```
                        ┌─────────────────────────┐
                        │   Ethereum (Hardhat /    │
                        │   Sepolia testnet)       │
                        │   ProductNFT.sol (ERC721)│
                        └───────▲──────────▲────────┘
                                │          │
                    ethers.js  │          │  ethers.js (đọc, không cần ví)
                    + MetaMask │          │
                                │          │
                 ┌──────────────┴───┐  ┌────┴──────────────────────┐
                 │   admin.html       │  │        Backend API         │
                 │  (Nhà sản xuất /   │  │     (Node.js + Express)    │
                 │  đơn vị phân phối) │  │  - lưu & phục vụ metadata  │
                 │  TỰ KÝ giao dịch   │  │    (mô phỏng IPFS gateway) │
                 │  bằng ví MetaMask  │  │  - sinh mã QR              │
                 │  của chính họ      │  │  - đọc dữ liệu on-chain    │
                 └────────────────────┘  │    để xác thực (read-only) │
                                          └──────────┬──────────────────┘
                                                      │ REST API
                                                      ▼
                                          ┌──────────────────────┐
                                          │  verify.html           │
                                          │  (Người tiêu dùng —   │
                                          │  quét QR, không cần ví)│
                                          └──────────────────────┘
```

**Điểm quan trọng nhất của kiến trúc này: backend không giữ private key của
bất kỳ ai.** Mọi giao dịch ghi lên blockchain (mint sản phẩm, cập nhật chuỗi
cung ứng) được **ký trực tiếp bằng ví MetaMask của người dùng** ngay trên
trình duyệt (xem `frontend/js/web3.js`) — đúng tinh thần phi tập trung của
blockchain: ai sở hữu ví, người đó chịu trách nhiệm và có toàn quyền kiểm
soát hành động của mình trên chuỗi. Backend chỉ đóng vai trò hạ tầng hỗ trợ:
lưu metadata trước khi mint, sinh QR sau khi mint thành công, và phục vụ dữ
liệu đọc (không cần ví, không tốn gas) cho trang xác thực người tiêu dùng.

**Lớp đăng nhập (MongoDB + JWT) là một lớp hoàn toàn tách biệt**, không
thay thế cho việc ký ví: trang quản trị (`admin.html`) yêu cầu đăng nhập
bằng tài khoản (username/password, lưu trên MongoDB, mật khẩu băm bằng
bcrypt) trước khi vào giao diện — mục đích chỉ để **gác không cho người lạ
tự ý mở trang quản trị**. Sau khi đăng nhập, mọi thao tác ghi lên blockchain
vẫn phải ký bằng ví MetaMask có đúng role trên smart contract như cũ — tài
khoản MongoDB không có quyền gì trên chain cả, hai lớp bảo vệ độc lập nhau.

Bốn thành phần, khớp với "Chương 3: Triển khai giải pháp" trong đề cương:

| Thư mục / Dịch vụ | Vai trò | Công nghệ |
|---|---|---|
| `smart-contracts/` | Hợp đồng thông minh ERC-721 ghi nhận sản phẩm + chuỗi cung ứng | Solidity, Hardhat, OpenZeppelin |
| `backend/` | API hỗ trợ: lưu metadata, sinh QR, phục vụ ABI/địa chỉ hợp đồng, đọc dữ liệu xác thực, đăng nhập/đăng ký | Node.js, Express, ethers.js (read-only), JWT, bcrypt |
| `frontend/` | Giao diện web: trang xác thực (quét QR), trang quản trị (đăng nhập + kết nối MetaMask, tự ký mint/transfer) | HTML/CSS/JS thuần, ethers.js (browser) |
| MongoDB | Lưu tài khoản đăng nhập trang quản trị — **không** lưu dữ liệu sản phẩm/chuỗi cung ứng (nguồn dữ liệu đó vẫn là blockchain) | MongoDB Atlas (hoặc self-host) |

## 2. Ánh xạ với đề cương

- **Chương 1 (Tổng quan)** → phần README này + chú thích trong `ProductNFT.sol` giải thích Blockchain, NFT (ERC-721), vai trò IPFS.
- **Chương 2 (Phân tích & thiết kế)**:
  - *Tác nhân hệ thống* → 4 vai trò: Admin, Manufacturer, Distributor, Người tiêu dùng (xem `roles` trong `index.html` và `AccessControl` trong contract).
  - *Quy trình nghiệp vụ* → 3 quy trình mint / transferCustody / verifyProduct trong `ProductNFT.sol`.
  - *Thiết kế dữ liệu* → metadata chuẩn NFT (`backend/src/services/storage.js`), cấu trúc `CustodyRecord`, thiết kế QR (`backend/src/services/qrcode.js`).
  - *Thiết kế smart contract* → `smart-contracts/contracts/ProductNFT.sol` (đã chọn chuẩn ERC-721, có phân quyền, có cơ chế thu hồi xác thực).
- **Chương 3 (Triển khai & đánh giá)** → hướng dẫn cài đặt bên dưới; `test/ProductNFT.test.js` là kịch bản thực nghiệm mint/transfer/revoke để đo tính đúng đắn; có thể mở rộng đo gas (`hardhat-gas-reporter`) cho phần "đánh giá chi phí vận hành".

## 3. Cài đặt & chạy thử (môi trường local)

Yêu cầu: Node.js ≥ 18.

### Bước 1 — Khởi động mạng blockchain cục bộ

```bash
cd smart-contracts
npm install
npx hardhat node
```//giữ terminal này chạy — đây là mạng Ethereum giả lập với 20 tài khoản có sẵn ETH

### Bước 2 — Triển khai smart contract (terminal mới)

```bash
cd smart-contracts
npx hardhat run scripts/deploy.js --network localhost
```

Lệnh này tự động ghi địa chỉ hợp đồng + ABI vào
`backend/src/data/contract.json` để backend đọc.

### Bước 3 — Cài MetaMask và import tài khoản Hardhat

Nếu chưa có, cài extension [MetaMask](https://metamask.io) trên trình duyệt.

Copy 3 dòng **Private Key** của Account #0, #1, #2 hiện ra ở terminal chạy
`hardhat node` (bước 1), rồi trong MetaMask: **Add account → Import account**,
dán từng private key vào để có 3 tài khoản tương ứng 3 vai trò:
- Account #0 → **Admin** (tài khoản deploy, có mọi quyền)
- Account #1 → **Nhà sản xuất** (đã được cấp `MANUFACTURER_ROLE` khi deploy)
- Account #2 → **Đơn vị phân phối** (đã được cấp `DISTRIBUTOR_ROLE` khi deploy)

Khi vào trang `admin.html` và bấm "Kết nối ví MetaMask" lần đầu, hệ thống sẽ
tự động yêu cầu MetaMask thêm mạng "Hardhat Local" (chainId 31337,
RPC `http://127.0.0.1:8545`) nếu chưa có — chỉ cần bấm chấp thuận.

### Bước 4 — Cấu hình MongoDB (cho tính năng đăng nhập quản trị)

Trang quản trị (`admin.html`) giờ yêu cầu đăng nhập trước khi vào — tài
khoản lưu trên MongoDB. Cách nhanh nhất (miễn phí, không cần cài gì):

1. Đăng ký **https://www.mongodb.com/cloud/atlas/register**
2. Tạo Cluster miễn phí (chọn gói **M0**)
3. **Database Access** → Add New Database User → đặt username/password
4. **Network Access** → Add IP Address → chọn **Allow Access From Anywhere**
   (`0.0.0.0/0` — đủ dùng cho demo/dev, siết lại khi triển khai thật)
5. Bấm **Connect** → **Drivers** → copy chuỗi kết nối dạng
   `mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/...`
   (thay `<password>` bằng mật khẩu bạn vừa tạo ở bước 3)

Sẽ dùng chuỗi này ở bước 5.

### Bước 5 — Chạy backend API

```bash
cd backend
npm install
cp .env.example .env
```

Mở file `.env` vừa tạo, điền:
```
MONGODB_URI=<chuỗi kết nối lấy ở Bước 4>
JWT_SECRET=<tự nghĩ ra một chuỗi bí mật bất kỳ, càng dài càng tốt>
```

Chạy:
```bash
npm run dev
```

Backend chạy tại `http://localhost:4000`. Lưu ý: **backend không giữ
private key ví nào** — mọi giao dịch ghi lên blockchain vẫn được ký trực
tiếp từ ví MetaMask của người dùng ngay trên trình duyệt. Tài khoản
đăng nhập (MongoDB) chỉ là lớp "gác cổng" vào giao diện quản trị, hoàn
toàn tách biệt với việc ký giao dịch on-chain.

### Bước 6 — Tạo tài khoản quản trị đầu tiên và chạy frontend

Frontend là HTML/CSS/JS thuần, không cần build. Cách đơn giản nhất:

```bash
cd frontend
npx serve . -p 5173
# hoặc: python3 -m http.server 5173
```

Mở `http://localhost:5173/admin.html` — vì chưa đăng nhập, sẽ tự chuyển
sang `login.html`. Bấm **"Chưa có tài khoản? Đăng ký ngay"**, tạo tài khoản
đầu tiên và **chọn vai trò "Admin"** (quan trọng — tài khoản admin đầu
tiên này dùng để duyệt cấp quyền cho các nhà cung cấp đăng ký sau). Đăng
ký xong tự động vào thẳng `admin.html`.

Bấm **"Kết nối ví MetaMask"**, chọn tài khoản **Account #0** (ví đã được
cấp `DEFAULT_ADMIN_ROLE` lúc deploy) → phát hành (mint) sản phẩm đầu tiên
(MetaMask sẽ bật popup yêu cầu xác nhận giao dịch) → sau đó mở
`http://localhost:5173/verify.html` để quét/nhập token vừa tạo và xem kết
quả xác thực (trang này **không cần đăng nhập, không cần ví** — người
tiêu dùng chỉ đọc dữ liệu công khai).

### Cách cấp quyền cho nhà cung cấp/phân phối mới (đăng ký sau)

Khi có ai đăng ký tài khoản mới (chọn vai trò "Nhà sản xuất" hoặc "Đơn vị
phân phối"), họ **chưa mint/chuyển giao được ngay** — cần admin duyệt cấp
quyền on-chain trước:

1. Người đăng ký mới đăng nhập → bấm "Kết nối ví MetaMask" (dùng ví họ tự
   tạo, ví dụ Account #3, #4... chưa được cấp quyền gì) → hệ thống tự lưu
   địa chỉ ví này vào tài khoản, đánh dấu "Đang chờ duyệt"
2. Tài khoản **admin** đăng nhập → vào mục **"Quản lý người dùng"** ở
   sidebar → thấy tài khoản mới với trạng thái "Đang chờ duyệt"
3. Admin bấm **"Cấp quyền"** → MetaMask **của admin** bật popup yêu cầu ký
   giao dịch `grantRole()` thật trên smart contract → sau khi xác nhận,
   trạng thái chuyển thành "Đã cấp quyền"
4. Từ giờ, ví của người dùng mới đã có `MANUFACTURER_ROLE`/`DISTRIBUTOR_ROLE`
   thật trên chain, mint/chuyển giao được bình thường

Lưu ý: bước duyệt này **bắt buộc phải do chính admin ký bằng ví của họ** —
backend không thể tự động cấp quyền hộ, vì không giữ private key của admin
(đúng nguyên tắc phi tập trung xuyên suốt project này).

Để test bước "Cập nhật chuỗi cung ứng", chuyển MetaMask sang Account #1
hoặc #2 tuỳ vai trò cần thao tác rồi thử chuyển giao token vừa mint.

> Nếu deploy backend ở domain khác `localhost:4000`, chỉnh biến
> `window.API_BASE` trong các file HTML hoặc set trước khi load script.
> Mặc định, cả `verify.html` và `admin.html` tự nhận diện host dựa theo
> `window.location.hostname` (không hardcode "localhost"), nên khi mở qua
> IP LAN từ điện thoại, chúng tự động gọi đúng API — không cần chỉnh gì.

### Demo bằng điện thoại thật qua mạng LAN

`localhost` luôn có nghĩa là "chính thiết bị đang mở trình duyệt" — điện
thoại không thể dùng `localhost` để truy cập server trên laptop của bạn.
Muốn quét QR bằng điện thoại thật (thay vì tải ảnh lên như hướng dẫn ở
mục xác thực), làm theo các bước sau:

1. Đảm bảo điện thoại và laptop **cùng một mạng WiFi**.
2. Lấy địa chỉ IP LAN của laptop:
   ```bash
   ipconfig          # Windows — tìm dòng "IPv4 Address"
   # hoặc: ifconfig   # macOS/Linux
   ```
   Ví dụ ra `192.168.1.5`.
3. Trong `backend/.env`, đổi 2 dòng sau sang IP vừa lấy được (thay vì
   `localhost`), vì đây là URL sẽ được **nhúng thẳng vào mã QR** lúc mint:
   ```
   PUBLIC_BASE_URL=http://192.168.1.5:4000
   FRONTEND_VERIFY_URL=http://192.168.1.5:5173/verify.html
   ```
   Restart backend (`Ctrl+C` rồi `npm run dev`) để áp dụng.
4. Mint sản phẩm mới **sau khi** đã đổi `.env` — các sản phẩm mint từ
   trước khi đổi vẫn có QR trỏ vào `localhost` cũ, không quét được từ điện
   thoại (chỉ ảnh hưởng QR cũ, không ảnh hưởng dữ liệu blockchain).
5. Trên điện thoại, quét QR như bình thường — hoặc mở tay
   `http://192.168.1.5:5173/verify.html`.

> Đây chỉ cần thiết cho việc **demo/quét bằng điện thoại thật**. Nếu chỉ
> test trên cùng một máy, dùng chức năng "Tải ảnh mã QR lên" ở `verify.html`
> hoặc nhập Token ID thủ công — không cần đổi `.env` gì cả.

## 7. Triển khai thật lên Internet (Vercel + Render + Sepolia)

Cách này cho ra **địa chỉ cố định, không đổi dù bạn ở đâu, dùng mạng gì** —
phù hợp để demo bảo vệ đồ án hoặc nộp link cho giảng viên. Làm 1 lần duy
nhất, sau đó dùng mãi mãi (không cần lặp lại các bước ipconfig/ngrok mỗi
khi đổi vị trí như chạy local).

### 7.1. Lấy RPC Sepolia (miễn phí)

1. Đăng ký tại **https://www.alchemy.com** (hoặc `infura.io`)
2. Tạo App mới → chọn mạng **Ethereum Sepolia**
3. Copy **HTTPS RPC URL** (dạng `https://eth-sepolia.g.alchemy.com/v2/...`)

### 7.2. Lấy ETH Sepolia miễn phí (để trả phí gas khi deploy/mint)

Vào một faucet công khai, ví dụ **https://www.alchemy.com/faucets/ethereum-sepolia**
hoặc **https://sepoliafaucet.com** → dán địa chỉ ví MetaMask của bạn → nhận
ETH test miễn phí (thường 0.05–0.5 ETH, đủ dùng cho cả đồ án).

> MetaMask đã có sẵn mạng Sepolia — vào **Settings → General → bật "Show
> test networks"** để thấy nó trong danh sách mạng, không cần tự thêm.

### 7.3. Deploy smart contract lên Sepolia

```bash
cd smart-contracts
cp .env.example .env
```
Điền vào `.env`:
- `SEPOLIA_RPC_URL` — URL lấy ở bước 7.1
- `PRIVATE_KEY` — private key ví MetaMask của bạn (MetaMask → ⋮ cạnh tên
  tài khoản → Account details → Show private key)
- `MANUFACTURER_ADDRESS` / `DISTRIBUTOR_ADDRESS` — địa chỉ ví thật của
  nhà sản xuất/phân phối (có thể điền cùng địa chỉ ví bạn cho cả 2 nếu
  demo một mình)

Chạy:
```bash
npx hardhat run scripts/deploy.js --network sepolia
```
Chờ vài chục giây (mạng thật chậm hơn local nhiều) — xong sẽ thấy địa chỉ
contract + 2 dòng cấp quyền, và `backend/src/data/contract.json` được ghi
với địa chỉ Sepolia thật.

### 7.4. Đưa code lên GitHub

Render và Vercel đều deploy từ GitHub. Nếu project chưa phải git repo:
```bash
cd .. # về thư mục gốc blockchain-nft-traceability
git init
git add .
git commit -m "Initial commit"
```
Tạo repo mới trên **github.com** (New repository) → làm theo hướng dẫn
`git remote add origin ...` rồi `git push` mà GitHub hiển thị sau khi tạo.

> `.gitignore` đã loại trừ `.env` — private key sẽ KHÔNG bị đẩy lên GitHub,
> yên tâm.

### 7.5. Deploy backend lên Render

1. Đăng ký **render.com** (miễn phí, đăng nhập bằng GitHub cho nhanh)
2. **New → Web Service** → chọn đúng repo vừa tạo
3. Cấu hình:
   - **Root Directory**: `backend`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Vào tab **Environment**, thêm các biến (copy giá trị tương ứng đã dùng
   ở các bước trên):
   ```
   RPC_URL=<SEPOLIA_RPC_URL ở bước 7.1>
   CHAIN_ID_HEX=0xaa36a7
   CHAIN_NAME=Sepolia
   PINATA_JWT=<JWT Pinata của bạn>
   PINATA_GATEWAY=https://gateway.pinata.cloud/ipfs
   ```
   2 biến `PUBLIC_BASE_URL` và `FRONTEND_VERIFY_URL` để trống tạm — quay
   lại điền sau khi có URL Render/Vercel thật (bước 7.7).
5. Bấm **Create Web Service** → chờ deploy xong, copy URL Render cấp
   (dạng `https://ten-project.onrender.com`)

> Lưu ý gói Free của Render: file lưu cục bộ, bao gồm cache JSON, ảnh QR và
> metadata dự phòng, có thể mất khi service khởi động lại hoặc deploy lại.
> Danh sách sản phẩm được dựng lại từ smart contract và metadata đã pin trên
> Pinata; mã QR cũng được tạo lại khi cần. Danh bạ đối tác vẫn đang lưu trong
> `partners.json`, nên muốn giữ danh bạ qua các lần khởi động cần dùng MongoDB
> hoặc Persistent Disk.

### 7.6. Deploy frontend lên Vercel

1. Đăng ký **vercel.com** (miễn phí, đăng nhập bằng GitHub)
2. **Add New → Project** → chọn đúng repo
3. Cấu hình: **Root Directory** chọn `frontend`, Framework Preset chọn
   **Other** (vì đây là HTML/CSS/JS thuần, không cần build)
4. Bấm **Deploy** → chờ xong, copy URL Vercel cấp (dạng
   `https://ten-project.vercel.app`)

### 7.7. Nối 2 địa chỉ lại với nhau

Giờ đã có đủ 2 URL thật, quay lại điền nốt:

**a) Trong `frontend/js/config.js`**, sửa dòng:
```js
const PROD_API_BASE = "https://ten-project.onrender.com"; // URL Render thật
```
Commit + push (`git add . && git commit -m "config prod API" && git push`)
— Vercel tự động deploy lại sau vài chục giây.

**b) Quay lại Render**, vào tab Environment, điền nốt 2 biến còn thiếu:
```
PUBLIC_BASE_URL=https://ten-project.onrender.com
FRONTEND_VERIFY_URL=https://ten-project-frontend.vercel.app/verify.html
```
Lưu lại — Render tự redeploy.

### 7.8. Mint sản phẩm mới và test

Mở `https://ten-project-frontend.vercel.app/admin.html` → kết nối MetaMask
(nhớ chuyển sang mạng **Sepolia** trong MetaMask trước) → mint thử.
Từ giờ, QR sinh ra sẽ trỏ đúng vào URL Vercel thật — quét được từ **bất kỳ
thiết bị nào có Internet, không cần cùng mạng, không cần đổi gì khi di
chuyển địa điểm**.

### Chạy test hợp đồng thông minh

```bash
cd smart-contracts
npx hardhat test
```

Bộ test (`test/ProductNFT.test.js`) kiểm tra: mint thành công, chặn mint
trái phép, ghi đúng lịch sử chuỗi cung ứng qua nhiều lần chuyển giao, thu
hồi xác thực khi phát hiện gian lận, và báo lỗi khi xác thực token không
tồn tại (trường hợp nghi ngờ QR giả mạo).

### Đo chi phí gas (phục vụ mục "Đánh giá thực nghiệm")

```bash
cd smart-contracts
npm run test:gas
```

Lệnh này chạy lại đúng bộ test ở trên, nhưng bật thêm
[`hardhat-gas-reporter`](https://www.npmjs.com/package/hardhat-gas-reporter),
in ra một bảng tổng hợp: mỗi hàm (`mintProduct`, `transferCustody`,
`revokeAuthenticity`...) tốn bao nhiêu gas trung bình/nhỏ nhất/lớn nhất, và
chi phí ước tính khi deploy contract — dùng số liệu này để viết mục đánh
giá chi phí vận hành trong báo cáo (ví dụ so sánh mint 1 sản phẩm tốn bao
nhiêu gas, quy đổi sang chi phí thực tế nếu deploy trên mainnet/Layer-2).

Mặc định chỉ hiện số gas thô (đủ dùng cho báo cáo). Muốn quy đổi thêm ra
USD, đăng ký API key miễn phí tại https://coinmarketcap.com/api rồi thêm
vào `.env`:
```
COINMARKETCAP_API_KEY=...
```

> Lưu ý: lần đầu chạy `hardhat compile`/`hardhat test`, Hardhat cần tải bộ
> biên dịch Solidity qua Internet — hãy đảm bảo máy chạy có kết nối mạng
> bình thường (không bị giới hạn domain như trong môi trường sandbox tạo
> ra dự án này).

## 4. Luồng nghiệp vụ chính

1. **Phát hành (Minting)** — Nhà sản xuất mở `admin.html`, kết nối ví
   MetaMask, nhập thông tin sản phẩm → backend lưu metadata trước và trả về
   `tokenURI` → trình duyệt gọi thẳng `mintProduct()` trên smart contract,
   **MetaMask bật popup yêu cầu chính nhà sản xuất xác nhận và ký giao
   dịch** → sau khi giao dịch được xác nhận, backend sinh mã QR gắn với
   tokenId thật → dán QR lên sản phẩm thật.
2. **Chuyển giao chuỗi cung ứng** — Mỗi lần sản phẩm đổi tay (nhà sản xuất
   → phân phối → bán lẻ), bên liên quan kết nối đúng ví của mình trong
   `admin.html` và tự ký gọi `transferCustody()` — ghi lại vị trí/thời
   gian/hành động, không qua trung gian nào có thể giả mạo chữ ký thay họ.
3. **Xác thực người tiêu dùng** — Quét QR → `verify.html` gọi
   `GET /api/products/verify/:tokenId` → backend đọc trực tiếp từ smart
   contract (chỉ đọc, miễn phí, không cần ví) → hiển thị "con dấu" xanh
   (chính hãng) kèm toàn bộ lịch sử, hoặc dấu đỏ nếu token không tồn tại /
   đã bị thu hồi (dấu hiệu hàng giả).

## 5. Ghi chú triển khai thực tế (production)

Các phần sau đang được **giả lập cho môi trường demo/dev** và cần thay thế
khi triển khai thật:

- **IPFS**: `backend/src/services/storage.js` hiện lưu metadata dưới dạng
  file JSON cục bộ, phục vụ qua route `/metadata/:id` để đóng vai trò
  tương đương gateway IPFS. Khi triển khai thật, thay bằng tích hợp
  [Pinata](https://docs.pinata.cloud) hoặc [web3.storage](https://web3.storage)
  để lưu thật sự phi tập trung.
- **Ví người dùng**: kiến trúc hiện tại đã dùng MetaMask để mỗi vai trò tự
  ký giao dịch — đúng hướng cho production. Khi lên thật, cần thêm bước xác
  thực danh tính đứng sau mỗi ví (ví dụ SIWE — Sign-In with Ethereum) để hệ
  thống biết "ví 0x... thuộc công ty nào" trước khi tin tưởng hiển thị
  thông tin nhà sản xuất tương ứng.
- **Mạng blockchain**: đổi `RPC_URL` trong `.env` (backend) và cấu hình mạng
  MetaMask sang một testnet (ví dụ Sepolia, cấu hình sẵn trong
  `hardhat.config.js`) hoặc mainnet/Layer-2 chi phí thấp (Polygon, Base...)
  để giảm phí gas khi vận hành thật.
- **Danh bạ đối tác**: đã có — `admin.html` cho phép đăng ký tên + địa chỉ
  ví của từng nhà phân phối/cửa hàng (mục "Danh bạ đối tác"), rồi chọn từ
  dropdown khi cập nhật chuỗi cung ứng thay vì gõ tay địa chỉ ví, giảm sai
  sót. Dữ liệu lưu tại `backend/src/data/partners.json`. Khi triển khai
  thật, nên thêm bước xác thực (SIWE hoặc tài khoản doanh nghiệp) trước khi
  cho phép đăng ký đối tác mới, tránh ai cũng thêm được vào danh bạ.

## 6. Cấu trúc thư mục

```
blockchain-nft-traceability/
├── smart-contracts/
│   ├── contracts/ProductNFT.sol       # Hợp đồng ERC-721 chính
│   ├── scripts/deploy.js              # Script triển khai
│   ├── test/ProductNFT.test.js        # Bộ test
│   └── hardhat.config.js
├── backend/
│   ├── src/server.js                  # Điểm khởi động Express
│   ├── src/routes/products.js         # API mint / transfer / verify
│   └── src/services/                  # blockchain.js, storage.js, qrcode.js, cache.js
└── frontend/
    ├── index.html                     # Trang giới thiệu
    ├── verify.html                    # Quét QR / xác thực
    ├── admin.html                     # Mint & quản lý chuỗi cung ứng
    └── css/styles.css
```
