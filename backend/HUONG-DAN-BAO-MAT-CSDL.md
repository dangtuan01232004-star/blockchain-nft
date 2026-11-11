# Bảo mật cơ sở dữ liệu (MongoDB Atlas) và IPFS (Pinata)

## Phần A — Những gì code đã tự làm

| Lớp bảo vệ | Ở đâu |
|---|---|
| Mật khẩu băm **bcrypt**; mã cào và mã dự phòng 2FA băm **HMAC** | `routes/auth.js`, `services/claimCodes.js` |
| Tên, SĐT, địa chỉ người mua mã hoá **AES-256-GCM**. Khoá nằm trên Render, không nằm trong DB | `services/crypto.js`, `services/orderPrivacy.js` |
| Chống NoSQL injection: dữ liệu đầu vào ép thành chuỗi, bật `strictQuery` | các route, `services/db.js` |
| **Bắt buộc TLS** khi kết nối DB qua Internet. Production từ chối kết nối nếu không có TLS | `services/db.js` |
| **Tự kiểm tra quyền user DB** lúc khởi động. Quyền quá rộng (atlasAdmin, readWriteAnyDatabase…) thì ghi cảnh báo vào nhật ký bảo mật và gửi Telegram | `services/db.js` |
| Log không in mật khẩu DB (tự che thành `//***@`) | `services/db.js`, scripts |
| **Sao lưu mã hoá** AES-256-GCM, có kiểm tra toàn vẹn | `scripts/backup-db.js`, `scripts/restore-db.js` |
| Upload ảnh: **chỉ nhận JPEG/PNG/WebP thật** (kiểm tra nội dung file) và **xoá EXIF/GPS** trước khi đưa lên IPFS. File giả bị chặn và báo admin | `services/imageSanitize.js`, `services/storage.js` |

---

## Phần B — Cấu hình MongoDB Atlas (làm 1 lần, khoảng 15 phút)

### B1. Bật 2FA cho tài khoản Atlas (quan trọng nhất)
Vào cloud.mongodb.com → avatar góc phải → **Account** → **Security** → **Multi-Factor Authentication**, rồi bật app Authenticator.
> Ai vào được Atlas là xem, xoá được toàn bộ DB. Mọi lớp bảo vệ khác đều vô nghĩa nếu lộ tài khoản này.

### B2. Hạ quyền user mà backend đang dùng
1. Vào **Security** → **Database Access** → chọn user backend đang dùng → **Edit**.
2. Mục **Database User Privileges**, chọn **Specific Privileges** → **Add Specific Privilege**:
   - Role: `readWrite`
   - Database: tên DB của project (phần sau dấu `/` trong `MONGODB_URI`, ví dụ `nfttrace`)
3. **Bỏ** quyền mặc định *"Read and write to any database"* (readWriteAnyDatabase).
4. Bấm **Update User**.

Sau khi Render deploy lại, log khởi động phải có dòng:
```
✓ Bảo mật DB: TLS bật, user "..." quyền readWrite@nfttrace
```
Nếu còn quyền rộng, log hiện `⚠ Bảo mật DB: User DB ... có quyền QUÁ RỘNG`, đồng thời nhật ký bảo mật trên trang admin có cảnh báo `db_config_weak`.

### B3. Đổi mật khẩu DB
Chuỗi kết nối có thể đã xuất hiện trong ảnh chụp màn hình trước đây, nên cần đổi.
1. **Database Access** → **Edit** → **Edit Password** → **Autogenerate Secure Password** → copy mật khẩu → **Update User**.
2. Cập nhật `MONGODB_URI` mới ở **2 nơi**:
   - **Render**: service backend → **Environment** → `MONGODB_URI` → **Save** (Render tự deploy lại).
   - **GitHub**: repo → **Settings** → **Secrets and variables** → **Actions** → `MONGODB_URI` → **Update** (dùng cho monitor).

### B4. User riêng cho monitor (GitHub Actions)
Monitor chạy trên GitHub, mỗi lần một IP khác, nên không giới hạn IP được. Thay vào đó, dùng **user riêng với quyền tối thiểu**:
1. **Database Access** → **Add New Database User**, tên `nfttrace-monitor`, mật khẩu tự sinh.
2. **Specific Privileges**: `readWrite` trên DB của project. (Muốn chặt hơn: **Custom Roles** → chỉ cho `find`/`insert`/`update` trên `auditlogs`, `monitorstates`, `orders`, và chỉ `find` trên `users`.)
3. Đặt `MONGODB_URI` trên **GitHub Secrets** là chuỗi của user này. Render vẫn dùng user backend.

> Lộ secret trên GitHub thì chỉ mất user monitor, không mất user chính. Khi bảo vệ, nêu rõ đây là đánh đổi có chủ ý.

### B5. Giới hạn IP (Network Access)
- Nếu đang để `0.0.0.0/0` thì mọi IP đều thử đăng nhập được, chỉ cần đúng mật khẩu.
- Render bản trả phí có **IP outbound cố định**: service → **Connect** → **Outbound**. Thêm các IP này vào Atlas **Network Access** rồi xoá `0.0.0.0/0`.
- Render Free cùng monitor trên GitHub không có IP cố định, nên **buộc phải giữ `0.0.0.0/0`**. Khi đó bù lại bằng B1, B2, B3, B4: mật khẩu dài ngẫu nhiên, quyền tối thiểu, TLS bắt buộc.

### B6. Theo dõi
- **Project** → **Activity Feed**: xem ai đăng nhập Atlas, ai đổi user hay IP.
- **Alerts** → **Add Alert**: chọn sự kiện *User joined project*, *Database user created/deleted*, *Network access changed*, gửi qua Email.

### B7. Sao lưu định kỳ
Gói M0 miễn phí **không có backup tự động**.

**Lần đầu**, tạo khoá backup (khác `DATA_ENCRYPTION_KEY`):
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Thêm vào `backend/.env`:
```
BACKUP_KEY=<64 ký tự vừa tạo>
```
> **Cất khoá này vào trình quản lý mật khẩu.** Mất khoá thì file backup vô dụng.

**Sao lưu** (mỗi tuần, hoặc trước khi demo):
```
cd backend
node scripts/backup-db.js
```
Kết quả là file `backend/backups/nfttrace-<ngày giờ>.bak`, đã mã hoá và **không bị commit lên GitHub**. Chép file này ra Google Drive hoặc ổ cứng.

**Khôi phục:**
```
node scripts/restore-db.js backups/nfttrace-....bak          # xem trước, không ghi gì
node scripts/restore-db.js backups/nfttrace-....bak --yes    # khôi phục thật
```

---

## Phần C — Pinata / IPFS

> **IPFS là công khai và không xoá được hẳn.** Ai có CID đều xem được file. Tuyệt đối không đưa thông tin cá nhân lên IPFS. Hệ thống chỉ đưa metadata sản phẩm và ảnh các bước chuỗi cung ứng; ảnh đã được xoá EXIF/GPS trước khi upload.

### C1. API key giới hạn quyền (quan trọng nhất)
1. Vào app.pinata.cloud → **API Keys** → **New Key**.
2. **Tắt Admin**. Chỉ bật **pinFileToIPFS** và **pinJSONToIPFS**. **Không** bật unpin hay quản lý key.
3. Đặt tên `nfttrace-backend` → **Create** → copy **JWT**.
4. Trên **Render**: `PINATA_JWT` = JWT mới → **Save**.
5. Quay lại Pinata, **Revoke** key cũ.

Tác dụng: nếu JWT có bị lộ, kẻ tấn công chỉ upload thêm được file rác, **không gỡ được** ảnh hay metadata của sản phẩm thật.

### C2. Bật 2FA cho tài khoản Pinata
Vào **Account Settings** → **Security** → **Two-Factor Authentication**.

### C3. Vì sao không ai sửa được dữ liệu trên IPFS
CID là **mã băm của nội dung file**. Sửa 1 byte thì CID đổi, mà CID gốc đã được ghi trong **tokenURI trên blockchain**. Nên không thể tráo ảnh hay metadata của sản phẩm đã mint.

---

## Câu nói khi bảo vệ
*"Dữ liệu nhạy cảm trong MongoDB được mã hoá ở tầng ứng dụng, khoá nằm ngoài database, nên lộ database cũng không đọc được SĐT hay địa chỉ người mua. User DB chỉ có quyền tối thiểu, kết nối bắt buộc TLS, và hệ thống tự kiểm tra rồi cảnh báo nếu cấu hình sai. IPFS là công khai, nên hệ thống chỉ đưa lên dữ liệu sản phẩm, ảnh được kiểm tra đúng là ảnh và xoá toạ độ GPS trước khi upload, còn API key Pinata không có quyền xoá."*
