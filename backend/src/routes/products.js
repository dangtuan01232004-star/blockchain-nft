const express = require("express");
const multer = require("multer");
const { getReadOnlyContract } = require("../services/blockchain");
const { saveMetadata, savePhoto, getMetadataByTokenURI, resolvePhotoURL } = require("../services/storage");
const { generateProductQRCode } = require("../services/qrcode");
const { listProducts, addProduct } = require("../services/cache");
const { requireAuth } = require("../middleware/auth");
const { recordScan, evaluateSuspicion } = require("../services/scanGuard");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

/**
 * POST /api/products/photo
 * Upload ảnh chụp tại một bước chuỗi cung ứng (mint hoặc transferCustody).
 * Trả về { url } — dùng làm tham số photoURI khi gọi contract.
 * form-data field name: "photo"
 */
router.post("/photo", requireAuth, upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Thiếu file ảnh (field 'photo')" });
    const { url } = await savePhoto(req.file.buffer, req.file.mimetype, req.file.originalname);
    res.status(201).json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Lỗi khi tải ảnh lên" });
  }
});

/**
 * POST /api/products/metadata
 * Bước 1 của quy trình mint: lưu metadata sản phẩm TRƯỚC khi gọi smart
 * contract, trả về tokenURI để frontend truyền vào hàm mintProduct() khi
 * ký giao dịch bằng ví của nhà sản xuất (MetaMask).
 * body: { productCode, name, description, image, manufacturer, batch, attributes }
 */
router.post("/metadata", requireAuth, async (req, res) => {
  const { productCode, name, description, image, manufacturer, batch, attributes } = req.body;
  if (!productCode || !name) {
    return res.status(400).json({ error: "Thiếu productCode hoặc name" });
  }
  const metadata = {
    name,
    description: description || "",
    image: image || "",
    productCode,
    manufacturer: manufacturer || "",
    batch: batch || "",
    attributes: attributes || [],
    mintedAt: new Date().toISOString(),
  };
  try {
    const { url } = await saveMetadata(metadata);
    res.status(201).json({ tokenURI: url, metadata });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Lỗi khi lưu metadata lên IPFS" });
  }
});

/**
 * POST /api/products/record
 * Bước 2 của quy trình mint: sau khi frontend đã tự gửi giao dịch
 * mintProduct() thành công bằng ví người dùng, gọi endpoint này để backend
 * sinh mã QR (gắn đúng tokenId thật vừa được on-chain gán) và lưu vào danh
 * sách hiển thị ở trang quản trị.
 * body: { tokenId, productCode, name, manufacturer, batch, tokenURI, txHash }
 */
router.post("/record", requireAuth, async (req, res) => {
  try {
    const { tokenId, productCode, name, manufacturer, batch, tokenURI, txHash, mintedBy } = req.body;
    if (tokenId === undefined || !productCode || !tokenURI || !txHash) {
      return res.status(400).json({ error: "Thiếu tham số bắt buộc" });
    }

    const qr = await generateProductQRCode(tokenId);
    const record = {
      tokenId: String(tokenId),
      productCode,
      name,
      manufacturer: manufacturer || "",
      batch: batch || "",
      tokenURI,
      txHash,
      mintedBy: (mintedBy || "").toLowerCase(), // địa chỉ ví đã ký mint — dùng để hiển thị "Sản phẩm của tôi"
      qrCodeUrl: `${process.env.PUBLIC_BASE_URL || "http://localhost:4000"}/qrcodes/${tokenId}.png`,
      verifyUrl: qr.verifyUrl,
      mintedAt: new Date().toISOString(),
    };
    addProduct(record);
    res.status(201).json(record);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Lỗi khi ghi nhận sản phẩm" });
  }
});

/**
 * GET /api/products/verify/:tokenId
 * Endpoint xác thực chính — được gọi khi người dùng quét mã QR.
 * Chỉ đọc dữ liệu (không cần ví, không tốn gas), an toàn cho người tiêu dùng.
 */
router.get("/verify/:tokenId", async (req, res) => {
  const { tokenId } = req.params;
  const deviceId = req.query.deviceId || req.headers["x-device-id"] || "unknown";
  try {
    const contract = getReadOnlyContract();
    const [owner, uri, code, authentic, steps] = await contract.verifyProduct(tokenId);
    const history = await contract.getHistory(tokenId);
    const metadata = await getMetadataByTokenURI(uri);

    // Ghi nhận lượt quét này rồi đánh giá xem có dấu hiệu QR bị sao chép không
    // (cùng 1 tokenId nhưng bị quét từ quá nhiều thiết bị khác nhau — xem
    // backend/src/services/scanGuard.js).
    await recordScan(tokenId, deviceId, req.ip, req.headers["user-agent"]);
    const scan = await evaluateSuspicion(tokenId);

    res.json({
      tokenId,
      found: true,
      authentic,
      owner,
      productCode: code,
      tokenURI: uri,
      metadata,
      historyStepCount: Number(steps),
      scan,
      history: history.map((h) => ({
        actor: h.actor,
        actorRole: h.actorRole,
        location: h.location,
        action: h.action,
        timestamp: new Date(Number(h.timestamp) * 1000).toISOString(),
        photoURI: resolvePhotoURL(h.photoURI),
        gpsCoords: h.gpsCoords || "",
      })),
    });
  } catch (err) {
    // Token không tồn tại trên blockchain => rất có thể là hàng giả / mã QR giả mạo
    res.status(404).json({
      tokenId,
      found: false,
      authentic: false,
      message:
        "Không tìm thấy sản phẩm này trên blockchain. Đây có thể là hàng giả hoặc mã QR không hợp lệ.",
    });
  }
});

/** GET /api/products — danh sách sản phẩm đã mint (cho trang quản trị) */
router.get("/", (req, res) => {
  res.json(listProducts());
});

module.exports = router;
