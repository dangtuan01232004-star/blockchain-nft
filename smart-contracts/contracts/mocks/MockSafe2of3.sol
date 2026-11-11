// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * CHỈ DÙNG ĐỂ KIỂM THỬ — mô phỏng ví Safe multisig 2/3 trên mạng Hardhat local
 * (Safe thật được tạo tại app.safe.global, không cần contract này).
 * Có getOwners()/getThreshold() giống Safe để script chuyển quyền đọc được.
 */
contract MockSafe2of3 {
    address[] private owners;
    uint256 public constant THRESHOLD = 2;
    mapping(address => bool) public isOwner;

    struct Proposal { address target; bytes data; uint256 approvals; bool executed; }
    Proposal[] public proposals;
    mapping(uint256 => mapping(address => bool)) public approved;

    constructor(address[3] memory _owners) {
        for (uint256 i = 0; i < 3; i++) {
            owners.push(_owners[i]);
            isOwner[_owners[i]] = true;
        }
    }

    function getOwners() external view returns (address[] memory) { return owners; }
    function getThreshold() external pure returns (uint256) { return THRESHOLD; }

    /** Chủ sở hữu đề xuất giao dịch (tự tính là 1 chữ ký) */
    function propose(address target, bytes calldata data) external returns (uint256 id) {
        require(isOwner[msg.sender], "Khong phai chu Safe");
        proposals.push(Proposal(target, data, 0, false));
        id = proposals.length - 1;
        _approve(id);
    }

    function approve(uint256 id) external {
        require(isOwner[msg.sender], "Khong phai chu Safe");
        _approve(id);
    }

    function _approve(uint256 id) private {
        require(!approved[id][msg.sender], "Da ky roi");
        approved[id][msg.sender] = true;
        proposals[id].approvals++;
    }

    function execute(uint256 id) external {
        Proposal storage p = proposals[id];
        require(!p.executed, "Da thuc thi");
        require(p.approvals >= THRESHOLD, "Chua du chu ky");
        p.executed = true;
        (bool ok, bytes memory ret) = p.target.call(p.data);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }
}
