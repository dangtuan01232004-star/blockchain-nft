// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/**
 * @title ProductNFT
 * @notice Hợp đồng thông minh ERC-721 dùng để phát hành (mint) NFT đại diện
 *         cho một sản phẩm thực, ghi nhận toàn bộ lịch sử chuỗi cung ứng
 *         (custody history) và cho phép xác thực hàng chính hãng thông qua
 *         mã QR gắn trên sản phẩm.
 *
 * MÔ HÌNH PHÂN QUYỀN NHIỀU TẦNG (để mất 1 khoá không mất cả hệ thống):
 *  - DEFAULT_ADMIN_ROLE : quyền cao nhất — NÊN là ví đa chữ ký (Safe multisig).
 *                          Cấp/thu hồi OPERATOR, GUARDIAN; mở lại hệ thống
 *                          sau sự cố (unpause); gỡ cờ "ví bị xâm phạm".
 *  - OPERATOR_ROLE      : vận hành hằng ngày — cấp/thu hồi quyền nhà sản xuất
 *                          và phân phối (duyệt đối tác). KHÔNG cấp được quyền
 *                          admin/guardian cho ai → không leo thang được.
 *  - GUARDIAN_ROLE      : phản ứng khẩn cấp — dừng hệ thống (pause), đánh dấu
 *                          ví bị hack (flagCompromised), thu hồi xác thực sản
 *                          phẩm. KHÔNG cấp được quyền cho ai, KHÔNG mở lại được
 *                          hệ thống → guardian bị hack cũng chỉ gây gián đoạn.
 *  - MANUFACTURER_ROLE  : nhà sản xuất, được phép mint sản phẩm mới
 *  - DISTRIBUTOR_ROLE   : đơn vị phân phối/vận chuyển
 *  - Người tiêu dùng    : không cần vai trò, chỉ đọc qua verifyProduct /
 *                          securityStatus (view, miễn phí gas)
 */
contract ProductNFT is ERC721URIStorage, AccessControl, Pausable, EIP712 {
    bytes32 public constant MANUFACTURER_ROLE = keccak256("MANUFACTURER_ROLE");
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    uint256 private _nextTokenId;

    /// @dev Cờ nội bộ: chỉ cho phép chuyển NFT khi đang đi qua transferCustody()
    bool private _inCustodyTransfer;

    /// @notice Một bước trong chuỗi cung ứng của sản phẩm
    struct CustodyRecord {
        address actor;      // Địa chỉ ví thực hiện hành động
        string actorRole;   // Vai trò tại thời điểm ghi nhận (Manufacturer/Distributor/Consumer)
        string location;    // Vị trí / kho / trạm ghi nhận (dạng chữ, ví dụ "Kho Hà Nội")
        string action;      // Hành động: "MINTED", "SHIPPED", "RECEIVED", "SOLD", ...
        uint256 timestamp;  // Thời gian ghi nhận (block timestamp)
        string photoURI;    // Ảnh chụp tại bước này (link IPFS, "" nếu không có)
        string gpsCoords;   // Toạ độ GPS lúc ghi nhận, dạng "vĩ độ,kinh độ", "" nếu không có
    }

    /// @notice Trạng thái xác thực — cho phép thu hồi (revoke) nếu phát hiện gian lận
    mapping(uint256 => bool) public isRevoked;

    /// @notice Lịch sử chuỗi cung ứng theo từng tokenId
    mapping(uint256 => CustodyRecord[]) private _history;

    /// @notice Mã lô sản xuất / SKU gắn với từng tokenId, dùng để đối chiếu QR
    mapping(uint256 => string) public productCode;

    /// @notice Ví đã ký mint token này — dùng để khoanh vùng khi ví đó bị hack
    mapping(uint256 => address) public mintedBy;

    /**
     * @notice Thời điểm (unix, giây) mà một ví bị nghi đã bị xâm phạm.
     *         0 = ví bình thường. Mọi thao tác ví này ký TỪ thời điểm đó trở
     *         đi đều bị coi là nghi vấn (không xoá dữ liệu, chỉ gắn cờ).
     */
    mapping(address => uint256) public compromisedSince;

    /**
     * @notice Giới hạn số sản phẩm MỖI VÍ nhà sản xuất được mint trong 1 ngày
     *         (ngày tính theo UTC). Ví bị lộ khoá thì kẻ tấn công cũng chỉ mint
     *         được tối đa ngần này hàng giả "chính chủ" mỗi ngày, đủ thời gian
     *         cho Guardian phát hiện và gắn cờ. Chỉ admin (multisig) đổi được.
     */
    uint256 public dailyMintLimit = 50;
    uint256 public constant MAX_DAILY_MINT_LIMIT = 10000;
    mapping(address => uint256) private _mintDay;
    mapping(address => uint256) private _mintCount;

    /**
     * @notice MINT HAI CHỮ KÝ. Khi `mintAuthorizer` được đặt, mỗi lần mint phải
     *         kèm chữ ký uỷ quyền (EIP-712) của khoá này — do hệ thống chỉ cấp
     *         SAU KHI chính chủ xác thực lại bằng passkey / mã 2FA trên thiết bị
     *         của họ. Kẻ trộm được private key ví nhà sản xuất (dù biết cả mật
     *         khẩu tài khoản) vẫn KHÔNG mint được vì thiếu chữ ký thứ hai.
     *         Chữ ký gắn chặt với: ví mint, ví nhận, metadata, mã sản phẩm, ảnh,
     *         GPS, hạn dùng và nonce dùng-1-lần → không tái sử dụng / sửa nội dung được.
     *         Chỉ admin (multisig) đổi được khoá này.
     */
    address public mintAuthorizer;
    mapping(bytes32 => bool) public mintAuthUsed;
    bytes32 private constant MINT_AUTH_TYPEHASH =
        keccak256(
            "MintAuth(address minter,address to,bytes32 tokenURIHash,bytes32 productCodeHash,bytes32 photoURIHash,bytes32 gpsHash,bytes32 nonce,uint256 deadline)"
        );

    event ProductMinted(uint256 indexed tokenId, address indexed manufacturer, string productCode, string tokenURI);
    event CustodyTransferred(uint256 indexed tokenId, address indexed from, address indexed to, string action, string location);
    event ProductRevoked(uint256 indexed tokenId, string reason);
    event WalletCompromised(address indexed wallet, uint256 since, address indexed flaggedBy);
    event WalletCleared(address indexed wallet, address indexed clearedBy);
    event DailyMintLimitChanged(uint256 oldLimit, uint256 newLimit, address indexed changedBy);
    event MintAuthorizerChanged(address indexed oldAuthorizer, address indexed newAuthorizer, address indexed changedBy);

    constructor() ERC721("ProductTraceabilityNFT", "PTNFT") EIP712("NFTTrace", "1") {
        // Ví deploy nhận tạm cả 3 quyền quản trị để cấu hình ban đầu. Khi
        // triển khai thật, scripts/deploy.js sẽ chuyển DEFAULT_ADMIN_ROLE
        // sang ví multisig rồi tự từ bỏ quyền của ví deploy.
        // Ví deploy KHÔNG còn quyền mint (tách quyền quản trị khỏi sản xuất).
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);
        _grantRole(GUARDIAN_ROLE, msg.sender);

        // Quyền nhà sản xuất / phân phối do OPERATOR quản lý, không cần
        // multisig cho việc duyệt đối tác hằng ngày.
        _setRoleAdmin(MANUFACTURER_ROLE, OPERATOR_ROLE);
        _setRoleAdmin(DISTRIBUTOR_ROLE, OPERATOR_ROLE);
    }

    // ------------------------------------------------------------------
    // Nghiệp vụ chính
    // ------------------------------------------------------------------

    /**
     * @notice Nhà sản xuất phát hành NFT cho một sản phẩm thực.
     * @param to Địa chỉ ví nhận NFT (thường là ví của chính nhà sản xuất khi khởi tạo)
     * @param tokenURI_ Đường dẫn metadata (IPFS URI) chứa thông tin chi tiết sản phẩm
     * @param productCode_ Mã lô / SKU nội bộ để đối chiếu với mã QR in trên sản phẩm
     * @param photoURI_ Ảnh chụp lúc phát hành (link IPFS), có thể để rỗng ""
     * @param gpsCoords_ Toạ độ GPS lúc phát hành, dạng "vĩ độ,kinh độ", có thể để rỗng ""
     */
    function mintProduct(
        address to,
        string memory tokenURI_,
        string memory productCode_,
        string memory photoURI_,
        string memory gpsCoords_
    ) external onlyRole(MANUFACTURER_ROLE) whenNotPaused returns (uint256) {
        // Hệ thống đã bật mint hai chữ ký → bắt buộc dùng mintProductAuthorized
        require(mintAuthorizer == address(0), "Can chu ky uy quyen mint");
        return _mintProduct(to, tokenURI_, productCode_, photoURI_, gpsCoords_);
    }

    /**
     * @notice Mint có chữ ký uỷ quyền thứ hai (xem `mintAuthorizer`).
     * @param nonce    Mã ngẫu nhiên dùng 1 lần do hệ thống cấp
     * @param deadline Hạn dùng chữ ký (unix giây), thường 10 phút
     * @param authSig  Chữ ký EIP-712 của `mintAuthorizer`
     */
    function mintProductAuthorized(
        address to,
        string memory tokenURI_,
        string memory productCode_,
        string memory photoURI_,
        string memory gpsCoords_,
        bytes32 nonce,
        uint256 deadline,
        bytes calldata authSig
    ) external onlyRole(MANUFACTURER_ROLE) whenNotPaused returns (uint256) {
        require(mintAuthorizer != address(0), "Chua cau hinh khoa uy quyen");
        require(block.timestamp <= deadline, "Chu ky uy quyen het han");
        require(!mintAuthUsed[nonce], "Chu ky uy quyen da dung");
        bytes32 structHash = keccak256(
            abi.encode(
                MINT_AUTH_TYPEHASH,
                msg.sender,
                to,
                keccak256(bytes(tokenURI_)),
                keccak256(bytes(productCode_)),
                keccak256(bytes(photoURI_)),
                keccak256(bytes(gpsCoords_)),
                nonce,
                deadline
            )
        );
        require(ECDSA.recover(_hashTypedDataV4(structHash), authSig) == mintAuthorizer, "Chu ky uy quyen khong hop le");
        mintAuthUsed[nonce] = true;
        return _mintProduct(to, tokenURI_, productCode_, photoURI_, gpsCoords_);
    }

    function _mintProduct(
        address to,
        string memory tokenURI_,
        string memory productCode_,
        string memory photoURI_,
        string memory gpsCoords_
    ) private returns (uint256) {
        _useDailyMintQuota(msg.sender);
        uint256 tokenId = _nextTokenId;
        _nextTokenId++;

        _safeMint(to, tokenId);
        _setTokenURI(tokenId, tokenURI_);
        productCode[tokenId] = productCode_;
        mintedBy[tokenId] = msg.sender;

        _history[tokenId].push(
            CustodyRecord({
                actor: msg.sender,
                actorRole: "MANUFACTURER",
                location: "Factory",
                action: "MINTED",
                timestamp: block.timestamp,
                photoURI: photoURI_,
                gpsCoords: gpsCoords_
            })
        );

        emit ProductMinted(tokenId, msg.sender, productCode_, tokenURI_);
        return tokenId;
    }

    /**
     * @notice Chuyển giao quyền sở hữu / cập nhật một bước trong chuỗi cung ứng.
     *         CHỈ chủ sở hữu hiện tại của token mới được gọi. (Bản cũ cho mọi
     *         ví có DISTRIBUTOR_ROLE chuyển BẤT KỲ token nào — một ví phân phối
     *         bị hack sẽ chiếm được toàn bộ sản phẩm. Nay đã chặn.)
     * @param photoURI Ảnh chụp tại bước này (link IPFS), có thể để rỗng ""
     * @param gpsCoords Toạ độ GPS lúc ghi nhận, dạng "vĩ độ,kinh độ", có thể để rỗng ""
     */
    function transferCustody(
        uint256 tokenId,
        address newHolder,
        string memory actorRole,
        string memory location,
        string memory action,
        string memory photoURI,
        string memory gpsCoords
    ) external whenNotPaused {
        require(_ownerOf(tokenId) != address(0), "Token khong ton tai");
        require(!isRevoked[tokenId], "San pham da bi thu hoi xac thuc");
        require(ownerOf(tokenId) == msg.sender, "Khong co quyen chuyen giao");
        require(newHolder != address(0), "Nguoi nhan khong hop le");

        address previousOwner = msg.sender;
        _inCustodyTransfer = true;
        _transfer(previousOwner, newHolder, tokenId);
        _inCustodyTransfer = false;

        _history[tokenId].push(
            CustodyRecord({
                actor: msg.sender,
                actorRole: actorRole,
                location: location,
                action: action,
                timestamp: block.timestamp,
                photoURI: photoURI,
                gpsCoords: gpsCoords
            })
        );

        emit CustodyTransferred(tokenId, previousOwner, newHolder, action, location);
    }

    /**
     * @notice Thu hồi xác thực 1 sản phẩm khi phát hiện gian lận. Guardian
     *         làm được (phản ứng nhanh), admin (multisig) cũng làm được.
     *         Vẫn hoạt động khi hệ thống đang tạm dừng.
     */
    function revokeAuthenticity(uint256 tokenId, string memory reason) external {
        require(
            hasRole(GUARDIAN_ROLE, msg.sender) || hasRole(DEFAULT_ADMIN_ROLE, msg.sender),
            "Khong co quyen thu hoi"
        );
        require(_ownerOf(tokenId) != address(0), "Token khong ton tai");
        isRevoked[tokenId] = true;
        emit ProductRevoked(tokenId, reason);
    }

    // ------------------------------------------------------------------
    // Ứng phó sự cố
    // ------------------------------------------------------------------

    /// @notice Dừng khẩn cấp mọi thao tác mint / chuyển giao (Guardian)
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    /// @notice Mở lại hệ thống sau khi xử lý xong sự cố — chỉ admin (multisig)
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @notice Đánh dấu một ví đã bị xâm phạm: tước ngay quyền nhà sản xuất /
     *         phân phối / vận hành của ví đó, và gắn cờ nghi vấn cho MỌI sản
     *         phẩm mà ví này mint hoặc chuyển giao từ thời điểm `since`.
     *         Chỉ 1 giao dịch, không cần thu hồi từng token.
     * @param wallet Ví bị nghi bị hack
     * @param since  Thời điểm nghi bị lộ khoá (unix giây). Truyền 0 = "ngay bây giờ".
     */
    function flagCompromised(address wallet, uint256 since) external onlyRole(GUARDIAN_ROLE) {
        require(wallet != address(0), "Vi khong hop le");
        require(!hasRole(DEFAULT_ADMIN_ROLE, wallet), "Khong the gan co admin");
        if (since == 0) since = block.timestamp;
        require(since <= block.timestamp, "Thoi diem trong tuong lai");

        // Ví đã bị gắn cờ trước đó: chỉ cho phép lùi mốc về sớm hơn (mở rộng
        // vùng nghi vấn), không cho đẩy mốc về sau (thu hẹp, che giấu).
        uint256 current = compromisedSince[wallet];
        if (current == 0 || since < current) {
            compromisedSince[wallet] = since;
        }

        _revokeRole(MANUFACTURER_ROLE, wallet);
        _revokeRole(DISTRIBUTOR_ROLE, wallet);
        _revokeRole(OPERATOR_ROLE, wallet);

        emit WalletCompromised(wallet, compromisedSince[wallet], msg.sender);
    }

    /**
     * @notice Gỡ cờ sau khi đã điều tra và kết luận ví không bị hack (báo
     *         nhầm). Chỉ admin (multisig). KHÔNG tự cấp lại quyền — nếu cần,
     *         operator phải cấp lại như một đối tác mới.
     */
    function clearCompromised(address wallet) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(compromisedSince[wallet] != 0, "Vi chua bi gan co");
        compromisedSince[wallet] = 0;
        emit WalletCleared(wallet, msg.sender);
    }

    /// @notice Đổi giới hạn mint mỗi ngày — chỉ admin (multisig 2/3)
    function setDailyMintLimit(uint256 newLimit) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newLimit > 0 && newLimit <= MAX_DAILY_MINT_LIMIT, "Gioi han khong hop le");
        emit DailyMintLimitChanged(dailyMintLimit, newLimit, msg.sender);
        dailyMintLimit = newLimit;
    }

    /// @notice Đặt / đổi khoá uỷ quyền mint (bật mint hai chữ ký) — chỉ admin (multisig)
    function setMintAuthorizer(address newAuthorizer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit MintAuthorizerChanged(mintAuthorizer, newAuthorizer, msg.sender);
        mintAuthorizer = newAuthorizer;
    }

    /// @notice Số sản phẩm một ví đã mint trong ngày hôm nay (UTC)
    function mintedToday(address wallet) public view returns (uint256) {
        return _mintDay[wallet] == block.timestamp / 1 days ? _mintCount[wallet] : 0;
    }

    function _useDailyMintQuota(address wallet) private {
        uint256 today = block.timestamp / 1 days;
        if (_mintDay[wallet] != today) {
            _mintDay[wallet] = today;
            _mintCount[wallet] = 0;
        }
        require(_mintCount[wallet] < dailyMintLimit, "Vuot gioi han mint trong ngay");
        _mintCount[wallet] += 1;
    }

    // ------------------------------------------------------------------
    // Đọc dữ liệu
    // ------------------------------------------------------------------

    /// @notice Trả về toàn bộ lịch sử chuỗi cung ứng của một sản phẩm
    function getHistory(uint256 tokenId) external view returns (CustodyRecord[] memory) {
        require(_ownerOf(tokenId) != address(0), "Token khong ton tai");
        return _history[tokenId];
    }

    /**
     * @notice Hàm xác thực chính — được backend gọi khi người dùng quét mã QR.
     *         (Giữ nguyên chữ ký hàm cũ để không phá vỡ backend.)
     * @return owner Chủ sở hữu hiện tại của NFT
     * @return uri Metadata URI (IPFS) của sản phẩm
     * @return code Mã sản phẩm / SKU
     * @return authentic true nếu sản phẩm chưa bị thu hồi xác thực
     * @return steps Số bước đã ghi nhận trong chuỗi cung ứng
     */
    function verifyProduct(uint256 tokenId)
        external
        view
        returns (
            address owner,
            string memory uri,
            string memory code,
            bool authentic,
            uint256 steps
        )
    {
        require(_ownerOf(tokenId) != address(0), "San pham khong ton tai tren blockchain - CO THE LA HANG GIA");
        return (
            ownerOf(tokenId),
            tokenURI(tokenId),
            productCode[tokenId],
            !isRevoked[tokenId],
            _history[tokenId].length
        );
    }

    /**
     * @notice Kiểm tra sản phẩm có dính tới ví bị xâm phạm không.
     * @return suspect     true nếu có ít nhất 1 bước (mint hoặc chuyển giao)
     *                     do ví bị gắn cờ ký, tại/sau thời điểm bị lộ
     * @return actor       Ví bị gắn cờ đầu tiên tìm thấy (address(0) nếu không có)
     * @return since       Thời điểm ví đó bị nghi lộ khoá
     * @return stepIndex   Vị trí bước nghi vấn trong lịch sử
     */
    function securityStatus(uint256 tokenId)
        external
        view
        returns (bool suspect, address actor, uint256 since, uint256 stepIndex)
    {
        require(_ownerOf(tokenId) != address(0), "Token khong ton tai");
        CustodyRecord[] storage h = _history[tokenId];
        for (uint256 i = 0; i < h.length; i++) {
            uint256 s = compromisedSince[h[i].actor];
            if (s != 0 && h[i].timestamp >= s) {
                return (true, h[i].actor, s, i);
            }
        }
        return (false, address(0), 0, 0);
    }

    function totalMinted() external view returns (uint256) {
        return _nextTokenId;
    }

    // ------------------------------------------------------------------
    // Override nội bộ
    // ------------------------------------------------------------------

    /**
     * @dev Chặn mọi đường chuyển NFT khác ngoài transferCustody() (ví dụ
     *      transferFrom/safeTransferFrom chuẩn ERC-721). Nếu không chặn, chủ
     *      sở hữu có thể chuyển token mà KHÔNG để lại dấu vết trong lịch sử
     *      chuỗi cung ứng, và lách được kiểm tra thu hồi / tạm dừng.
     */
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0)) {
            require(_inCustodyTransfer, "Chi chuyen giao qua transferCustody");
        }
        return super._update(to, tokenId, auth);
    }

    // --- Bắt buộc override do đa kế thừa ERC721URIStorage + AccessControl ---
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorage, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
