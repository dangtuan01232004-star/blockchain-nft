// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title ProductNFT
 * @notice Hợp đồng thông minh ERC-721 dùng để phát hành (mint) NFT đại diện
 *         cho một sản phẩm thực, ghi nhận toàn bộ lịch sử chuỗi cung ứng
 *         (custody history) và cho phép xác thực hàng chính hãng thông qua
 *         mã QR gắn trên sản phẩm.
 *
 * Các tác nhân trong hệ thống:
 *  - ADMIN_ROLE         : quản trị hệ thống, cấp/thu hồi vai trò
 *  - MANUFACTURER_ROLE   : nhà sản xuất, được phép mint sản phẩm mới
 *  - DISTRIBUTOR_ROLE    : đơn vị phân phối/vận chuyển, được phép cập nhật
 *                          bước chuyển giao trong chuỗi cung ứng
 *  - Người tiêu dùng     : không cần vai trò đặc biệt, chỉ đọc dữ liệu qua
 *                          hàm verifyProduct (view, miễn phí gas)
 */
contract ProductNFT is ERC721URIStorage, AccessControl {
    bytes32 public constant MANUFACTURER_ROLE = keccak256("MANUFACTURER_ROLE");
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");

    uint256 private _nextTokenId;

    /// @notice Một bước trong chuỗi cung ứng của sản phẩm
    struct CustodyRecord {
        address actor;      // Địa chỉ ví thực hiện hành động
        string actorRole;   // Vai trò tại thời điểm ghi nhận (Manufacturer/Distributor/Consumer)
        string location;    // Vị trí / kho / trạm ghi nhận (dạng chữ, ví dụ "Kho Hà Nội")
        string action;      // Hành động: "MINTED", "SHIPPED", "RECEIVED", "SOLD", ...
        uint256 timestamp;  // Thời gian ghi nhận (block timestamp)
        string photoURI;    // Ảnh chụp tại bước này (link IPFS, "" nếu không có)
        string gpsCoords;   // Toạ độ GPS lúc ghi nhận, dạng "vĩ độ,kinh độ" (ví dụ "10.762622,106.660172"), "" nếu không có
    }

    /// @notice Trạng thái xác thực — cho phép Admin thu hồi (revoke) nếu phát hiện gian lận
    mapping(uint256 => bool) public isRevoked;

    /// @notice Lịch sử chuỗi cung ứng theo từng tokenId
    mapping(uint256 => CustodyRecord[]) private _history;

    /// @notice Mã lô sản xuất / SKU gắn với từng tokenId, dùng để đối chiếu QR
    mapping(uint256 => string) public productCode;

    event ProductMinted(uint256 indexed tokenId, address indexed manufacturer, string productCode, string tokenURI);
    event CustodyTransferred(uint256 indexed tokenId, address indexed from, address indexed to, string action, string location);
    event ProductRevoked(uint256 indexed tokenId, string reason);

    constructor() ERC721("ProductTraceabilityNFT", "PTNFT") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MANUFACTURER_ROLE, msg.sender);
    }

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
    ) external onlyRole(MANUFACTURER_ROLE) returns (uint256) {
        uint256 tokenId = _nextTokenId;
        _nextTokenId++;

        _safeMint(to, tokenId);
        _setTokenURI(tokenId, tokenURI_);
        productCode[tokenId] = productCode_;

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
     *         Chỉ chủ sở hữu hiện tại của token hoặc tài khoản có DISTRIBUTOR_ROLE
     *         mới được gọi hàm này.
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
    ) external {
        require(_ownerOf(tokenId) != address(0), "Token khong ton tai");
        require(!isRevoked[tokenId], "San pham da bi thu hoi xac thuc");
        require(
            ownerOf(tokenId) == msg.sender || hasRole(DISTRIBUTOR_ROLE, msg.sender),
            "Khong co quyen chuyen giao"
        );

        address previousOwner = ownerOf(tokenId);
        _transfer(previousOwner, newHolder, tokenId);

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

    /// @notice Admin có thể thu hồi xác thực nếu phát hiện gian lận / báo cáo hàng giả
    function revokeAuthenticity(uint256 tokenId, string memory reason) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(_ownerOf(tokenId) != address(0), "Token khong ton tai");
        isRevoked[tokenId] = true;
        emit ProductRevoked(tokenId, reason);
    }

    /// @notice Trả về toàn bộ lịch sử chuỗi cung ứng của một sản phẩm
    function getHistory(uint256 tokenId) external view returns (CustodyRecord[] memory) {
        require(_ownerOf(tokenId) != address(0), "Token khong ton tai");
        return _history[tokenId];
    }

    /**
     * @notice Hàm xác thực chính — được backend gọi khi người dùng quét mã QR.
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

    function totalMinted() external view returns (uint256) {
        return _nextTokenId;
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
