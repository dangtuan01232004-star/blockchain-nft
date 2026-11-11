const express = require("express");
const multer = require("multer");
const { getReadOnlyContract } = require("../services/blockchain");
const { saveMetadata, savePhoto, getMetadataByTokenURI, resolvePhotoURL } = require("../services/storage");
const { generateProductQRCode, ensureProductQRCode } = require("../services/qrcode");
const { addProduct } = require("../services/cache");
const { listProductsFromBlockchain } = require("../services/productCatalog");
const { requireAuth, requireApproved, requireAdmin } = require("../middleware/auth");
const { rateLimit } = require("express-rate-limit");
const {
  issueClaimCode,
  claimProduct,
  getClaimStatus,
  reportProduct,
  recoverOwnership,
} = require("../services/claimCodes");
const { recordScan, evaluateSuspicion } = require("../services/scanGuard");
const { securityEvent } = require("../services/alerts");
const { issueMintAuthorization, getApprovalStatus } = require("../services/mintAuth");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

/**
 * POST /api/products/photo
 * Upload ảnh chụp tại một bước chuỗi cung ứng (mint hoặc transferCustody).
 * Trả về { url } — dùng làm tham số photoURI khi gọi contract.
 * form-data field name: "photo"
 */
router.post("/photo", requireAuth, requireApproved, upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Thiếu file ảnh (field 'photo')" });
    const { url } = await savePhoto(req.file.buffer, req.file.mimetype, req.file.originalname);
    res.status(201).json({ url });
  } catch (err) {
    if (err && err.status === 400) {
      // File không phải ảnh thật (HTML/SVG/exe đổi đuôi...) — ghi nhật ký vì có thể là thử tấn công
      await securityEvent({
        type: "upload_rejected",
        severity: "warning",
        message: `Tải lên file KHÔNG phải ảnh hợp lệ (${String(req.file.originalname || "").slice(0, 80)}, ${req.file.mimetype}) — đã chặn`,
        user: req.dbUser,
        ip: req.ip,
        dedupeKey: `upload_rejected:${req.dbUser && req.dbUser._id}:${Math.floor(Date.now() / 600000)}`,
      }).catch(() => {});
      return res.status(400).json({ error: err.message });
    }
    console.error(err);
    res.status(500).json({ error: err.message || "Lỗi khi tải ảnh lên" });
  }
});

/**
 * POST /api/products/mint-authorization — xin CHỮ KÝ THỨ HAI để mint (xem services/mintAuth.js).
 * body: { minter, to, tokenURI, productCode, photoURI, gpsCoords }
 */
router.post("/mint-authorization", requireAuth, requireApproved, async (req, res) => {
  try {
    const out = await issueMintAuthorization({ user: req.dbUser, session: req.authSession, ip: req.ip, body: req.body || {} });
    res.json(out);
  } catch (err) {
    if (err && err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code, approvalId: err.approvalId, minutes: err.minutes });
    }
    console.error(err);
    res.status(500).json({ error: "Không cấp được phép phát hành" });
  }
});

/** GET /api/products/mint-approval/:id — trạng thái duyệt trên Telegram (trang hỏi định kỳ) */
router.get("/mint-approval/:id", requireAuth, requireApproved, async (req, res) => {
  res.json(await getApprovalStatus(req.dbUser, req.authSession, req.params.id));
});

/**
 * POST /api/products/metadata
 * Bước 1 của quy trình mint: lưu metadata sản phẩm TRƯỚC khi gọi smart
 * contract, trả về tokenURI để frontend truyền vào hàm mintProduct() khi
 * ký giao dịch bằng ví của nhà sản xuất (MetaMask).
 * body: { productCode, name, description, image, manufacturer, batch, attributes }
 */
router.post("/metadata", requireAuth, requireApproved, async (req, res) => {
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
 * sinh mã QR (gắn đúng tokenId thật vừa được on-chain gán) và lưu thêm một
 * bản cache phụ. Danh sách chính được dựng lại từ blockchain.
 * body: { tokenId, productCode, name, manufacturer, batch, tokenURI, txHash }
 */
router.post("/record", requireAuth, requireApproved, async (req, res) => {
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
      qrCodeUrl: `/api/products/${tokenId}/qr`,
      verifyUrl: qr.verifyUrl,
      mintedAt: new Date().toISOString(),
    };
    addProduct(record);

    // Sinh mã cào dùng 1 lần — chỉ trả về ĐÚNG LẦN NÀY để in tem, server
    // chỉ giữ bản băm. Backend tự kiểm tra trên chain: chỉ ví đã mint mới sinh được.
    const issued = await issueClaimCode(tokenId, req.dbUser, req);
    res.status(201).json({
      ...record,
      claimCode: issued.ok ? issued.code : null,
      claimCodeError: issued.ok ? undefined : issued.error,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Lỗi khi ghi nhận sản phẩm" });
  }
});

/**
 * Đọc trạng thái an ninh on-chain của sản phẩm: có dính tới ví bị gắn cờ
 * "đã bị xâm phạm" không, và hệ thống có đang tạm dừng khẩn cấp không.
 * Tương thích ngược: contract cũ chưa có các hàm này thì trả về mặc định.
 */
async function readSecurityStatus(contract, tokenId) {
  const result = { suspect: false, suspectActor: "", compromisedSince: null, suspectStep: null, paused: false };
  try {
    const [suspect, actor, since, stepIndex] = await contract.securityStatus(tokenId);
    if (suspect) {
      result.suspect = true;
      result.suspectActor = actor;
      result.compromisedSince = new Date(Number(since) * 1000).toISOString();
      result.suspectStep = Number(stepIndex);
    }
  } catch {
    // contract cũ chưa có securityStatus()
  }
  try {
    result.paused = await contract.paused();
  } catch {
    // contract cũ chưa có Pausable
  }
  return result;
}

/**
 * GET /api/products/verify/:tokenId
 * Endpoint xác thực chính — được gọi khi người dùng quét mã QR.
 * Chỉ đọc dữ liệu (không cần ví, không tốn gas), an toàn cho người tiêu dùng.
 */
// Bộ nhớ đệm ngắn cho phần ĐỌC BLOCKCHAIN của trang xác thực: 1.000 người
// (hoặc 1 botnet) cùng quét 1 mã QR trong vài giây chỉ tốn ~1 lần đọc RPC.
// Phần ghi nhận lượt quét + trạng thái mã cào vẫn chạy cho TỪNG request.
const CHAIN_CACHE_MS = Number(process.env.VERIFY_CACHE_MS || 10000);
const chainCache = new Map(); // tokenId -> { at, value } | { at, promise }
function readChainProduct(tokenId) {
  const hit = chainCache.get(tokenId);
  if (hit && Date.now() - hit.at < CHAIN_CACHE_MS) return hit.promise;
  const promise = (async () => {
    const contract = getReadOnlyContract();
    const [owner, uri, code, authentic, steps] = await contract.verifyProduct(tokenId);
    const [history, metadata, security] = await Promise.all([
      contract.getHistory(tokenId),
      getMetadataByTokenURI(uri),
      readSecurityStatus(contract, tokenId),
    ]);
    return { owner, uri, code, authentic, steps, history, metadata, security };
  })();
  chainCache.set(tokenId, { at: Date.now(), promise });
  // Lỗi mạng/RPC thì không giữ trong cache; "không tồn tại" (CALL_EXCEPTION) thì giữ để chặn dò tokenId ngẫu nhiên
  promise.catch((err) => {
    if (!err || err.code !== "CALL_EXCEPTION") chainCache.delete(tokenId);
  });
  if (chainCache.size > 5000) {
    for (const [k, v] of chainCache) if (Date.now() - v.at > CHAIN_CACHE_MS) chainCache.delete(k);
  }
  return promise;
}

router.get("/verify/:tokenId", async (req, res) => {
  const { tokenId } = req.params;
  const deviceId = req.query.deviceId || req.headers["x-device-id"] || "unknown";
  if (!/^\d{1,12}$/.test(String(tokenId))) {
    return res.status(404).json({ tokenId, found: false, authentic: false, message: "Mã sản phẩm không hợp lệ." });
  }
  try {
    const { owner, uri, code, authentic, steps, history, metadata, security } = await readChainProduct(String(tokenId));

    // Ghi nhận lượt quét này rồi đánh giá xem có dấu hiệu QR bị sao chép không
    // (cùng 1 tokenId nhưng bị quét từ quá nhiều thiết bị khác nhau — xem
    // backend/src/services/scanGuard.js).
    await recordScan(tokenId, deviceId, req.ip, req.headers["user-agent"]);
    const scan = await evaluateSuspicion(tokenId);
    let claim = { status: "unknown" };
    try {
      claim = await getClaimStatus(tokenId, req.headers["x-owner-token"]);
    } catch (err) {
      console.error("Không đọc được trạng thái mã cào:", err.message);
    }

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
      security,
      claim,
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
    // Lỗi mạng / RPC (không phải do token không tồn tại) → KHÔNG được kết
    // luận "hàng giả": báo tạm thời không kiểm tra được. Nếu không, chỉ cần
    // làm sập RPC là mọi hàng thật đều hiện dấu đỏ.
    if (err && err.code !== "CALL_EXCEPTION") {
      console.error("Không đọc được blockchain khi xác thực:", err.message);
      return res.status(503).json({
        tokenId,
        found: null,
        message: "Tạm thời không kết nối được blockchain để xác thực. Vui lòng thử lại sau ít phút.",
      });
    }
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

// ---------------------------------------------------------------------
// Mã cào dùng 1 lần
// ---------------------------------------------------------------------

// Giới hạn theo IP — cộng thêm khoá 5 lần sai theo từng sản phẩm
const claimLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Bạn thử quá nhiều lần. Vui lòng đợi 15 phút." },
});
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Bạn đã gửi nhiều báo cáo. Vui lòng thử lại sau." },
});

/**
 * POST /api/products/:tokenId/claim — người mua kích hoạt bằng mã cào.
 * body: { code, contact? }  (contact: SĐT/email để khôi phục khi đổi máy)
 * Trả { ownerToken } — trình duyệt giữ token này để được nhận là chủ sở hữu.
 */
router.post("/:tokenId/claim", claimLimiter, async (req, res) => {
  try {
    const { code, contact } = req.body || {};
    if (!code) return res.status(400).json({ error: "Vui lòng nhập mã dưới lớp cào" });
    const r = await claimProduct(req.params.tokenId, code, contact, req);
    res.status(r.status).json(r.body);
  } catch (err) {
    console.error("Lỗi kích hoạt mã cào:", err);
    res.status(500).json({ error: "Không kích hoạt được, vui lòng thử lại" });
  }
});

/** POST /api/products/:tokenId/report — người quét báo nghi hàng giả. body: { message?, contact? } */
router.post("/:tokenId/report", reportLimiter, async (req, res) => {
  try {
    const { message, contact } = req.body || {};
    await reportProduct(req.params.tokenId, message, contact, req);
    res.json({ ok: true });
  } catch (err) {
    console.error("Lỗi gửi báo cáo:", err);
    res.status(500).json({ error: "Không gửi được báo cáo" });
  }
});

/**
 * POST /api/products/:tokenId/claim-code — CẤP LẠI mã cào (tem in hỏng / bị lộ
 * trước khi bán). Chỉ ví đã mint hoặc admin; chỉ khi chưa ai kích hoạt.
 * Mã cũ mất hiệu lực ngay.
 */
router.post("/:tokenId/claim-code", requireAuth, requireApproved, async (req, res) => {
  try {
    const r = await issueClaimCode(req.params.tokenId, req.dbUser, req, { regenerate: true });
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    res.json({ tokenId: req.params.tokenId, claimCode: r.code, version: r.version });
  } catch (err) {
    console.error("Lỗi cấp lại mã cào:", err);
    res.status(500).json({ error: "Không cấp lại được mã cào" });
  }
});

/**
 * POST /api/products/:tokenId/claim/recover — ADMIN cấp lại quyền chủ cho
 * khách đã đổi điện thoại (sau khi gọi điện xác minh). Trả link để gửi khách.
 */
router.post("/:tokenId/claim/recover", requireAuth, requireAdmin, async (req, res) => {
  try {
    const r = await recoverOwnership(req.params.tokenId, req.dbUser, req);
    if (!r.ok) return res.status(r.status).json({ error: r.error });
    const base = new URL(process.env.FRONTEND_VERIFY_URL || "http://localhost:5173/verify.html");
    base.searchParams.set("tokenId", req.params.tokenId);
    // Token đặt sau dấu # → không bị gửi lên server/không lưu trong log truy cập
    res.json({ link: `${base.href}#owner=${r.ownerToken}`, contactMasked: r.contactMasked });
  } catch (err) {
    console.error("Lỗi khôi phục quyền chủ:", err);
    res.status(500).json({ error: "Không khôi phục được" });
  }
});

/** GET /api/products — dựng danh sách từ blockchain, không phụ thuộc cache file */
router.get("/", async (req, res) => {
  res.set("Cache-Control", "public, max-age=30");
  try {
    res.json(await listProductsFromBlockchain());
  } catch (err) {
    console.error("Không tải được danh sách sản phẩm từ blockchain:", err);
    res.status(500).json({ error: err.message || "Không tải được danh sách sản phẩm" });
  }
});

router.get("/:tokenId/qr", async (req, res) => {
  try {
    const qr = await ensureProductQRCode(req.params.tokenId);
    res.sendFile(qr.filePath);
  } catch (err) {
    console.error("Không tạo được mã QR sản phẩm:", err);
    res.status(500).json({ error: err.message || "Không tạo được mã QR sản phẩm" });
  }
});

module.exports = router;
