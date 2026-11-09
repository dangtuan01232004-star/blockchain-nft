const translations = {
  vi: {
    nav_home: "Trang chủ",
    nav_sectors: "Lĩnh vực",
    nav_benefits: "Lợi ích",
    nav_features: "Tính năng",
    nav_tech: "Công nghệ",
    nav_verify: "Xác thực",
    nav_login: "Đăng nhập",
    hero_title: "Nền tảng định danh, xác thực và truy xuất<br>nguồn gốc sản phẩm, hàng hóa",
    hero_desc: "NFTTrace là giải pháp truy xuất nguồn gốc toàn diện, giúp theo dõi minh bạch toàn bộ hành trình sản phẩm trong chuỗi cung ứng, từ sản xuất đến tay người tiêu dùng.",
    hero_btn_verify: "Xác thực",
    hero_btn_stats: "Xem thống kê",
    flow_phone: "Quét QR xác thực tại mỗi bước",
    stat_products: "Sản phẩm đã phát hành NFT",
    stat_partners: "Đối tác trong chuỗi cung ứng",
    stat_standard: "Tiêu chuẩn NFT sử dụng",
    stat_signed: "Giao dịch ký trực tiếp bằng ví người dùng",
    pillars_title: "Ba trụ cột của hệ thống",
    pillars_sub: "Định danh, xác thực và truy xuất — mỗi trụ cột ứng với một thành phần kỹ thuật cụ thể.",
    pillar_tag1: "Định danh",
    pillar_h1: "Mint NFT cho từng sản phẩm",
    pillar_p1: "Nhà sản xuất phát hành NFT chuẩn ERC-721 duy nhất cho mỗi sản phẩm, metadata lưu trên IPFS, gắn mã QR vật lý lên bao bì.",
    pillar_tag2: "Xác thực",
    pillar_h2: "Smart contract trên Ethereum",
    pillar_p2: "Mọi giao dịch (mint, chuyển giao) được ký trực tiếp bằng ví MetaMask của từng vai trò — không máy chủ trung gian nào có thể chỉnh sửa dữ liệu.",
    pillar_tag3: "Truy xuất",
    pillar_h3: "Trang tra cứu công khai",
    pillar_p3: "Người tiêu dùng quét QR, xem toàn bộ lịch sử chuỗi cung ứng theo thời gian thực — không cần cài ví, không tốn phí gas.",
    tech_title: "Công nghệ sử dụng",
    tech_sub: "Kiến trúc phi tập trung ở mọi lớp — không có điểm nào một mình backend có thể thao túng dữ liệu.",
    tech_h1: "Nền tảng chuỗi khối",
    tech_p1: "Hợp đồng thông minh Solidity (ERC-721 + AccessControl của OpenZeppelin) triển khai trên Ethereum, đảm bảo dữ liệu minh bạch, bất biến.",
    tech_h2: "Lưu trữ phi tập trung IPFS",
    tech_p2: "Metadata sản phẩm (tên, mô tả, ảnh) được ghim lên IPFS qua Pinata, không phụ thuộc vào một máy chủ trung tâm duy nhất.",
    tech_h3: "Ký giao dịch phi tập trung",
    tech_p3: "Mỗi vai trò tự kết nối ví MetaMask và tự ký giao dịch của mình — backend không lưu giữ private key của bất kỳ ai.",
    footer_text: "Đồ án tốt nghiệp — Nghiên cứu triển khai giải pháp Blockchain kết hợp NFT chống hàng giả và truy xuất nguồn gốc trong TMĐT."
  },
  en: {
    nav_home: "Home",
    nav_sectors: "Sectors",
    nav_benefits: "Benefits",
    nav_features: "Features",
    nav_tech: "Technology",
    nav_verify: "Verify",
    nav_login: "Login",
    hero_title: "Product Identity, Verification &<br>Traceability Platform",
    hero_desc: "NFTTrace is a comprehensive traceability solution that provides transparent end-to-end supply chain tracking from production to consumer.",
    hero_btn_verify: "Verify Product",
    hero_btn_stats: "View Statistics",
    flow_phone: "Scan QR code to verify at each step",
    stat_products: "NFT Products Issued",
    stat_partners: "Supply Chain Partners",
    stat_standard: "NFT Standard Used",
    stat_signed: "Transactions Signed Direct with User Wallet",
    pillars_title: "Three Pillars of the System",
    pillars_sub: "Identity, Verification, and Traceability — each pillar corresponds to a specific technical component.",
    pillar_tag1: "Identity",
    pillar_h1: "Mint NFT for Each Product",
    pillar_p1: "Manufacturers issue unique ERC-721 NFTs for each product, metadata stored on IPFS, physical QR codes attached to packaging.",
    pillar_tag2: "Verification",
    pillar_h2: "Smart Contracts on Ethereum",
    pillar_p2: "All transactions (minting, transfers) are signed directly via MetaMask by each role — no central server can alter data.",
    pillar_tag3: "Traceability",
    pillar_h3: "Public Lookup Page",
    pillar_p3: "Consumers scan QR codes to view full real-time supply chain history — no wallet required, zero gas fees.",
    tech_title: "Technologies Used",
    tech_sub: "Decentralized architecture at every layer — no single backend point can manipulate data.",
    tech_h1: "Blockchain Platform",
    tech_p1: "Solidity smart contracts (ERC-721 + OpenZeppelin AccessControl) deployed on Ethereum, ensuring transparent, immutable data.",
    tech_h2: "Decentralized IPFS Storage",
    tech_p2: "Product metadata (name, description, image) pinned to IPFS via Pinata, independent of any central server.",
    tech_h3: "Decentralized Transaction Signing",
    tech_p3: "Each role connects their MetaMask wallet and signs their own transactions — backend holds zero private keys.",
    footer_text: "Graduation Project — Research and Implementation of Blockchain & NFT Anti-Counterfeiting and Traceability Solution in E-Commerce."
  }
};

function setLanguage(lang) {
  localStorage.setItem('app_lang', lang);
  document.querySelectorAll('.lang-opt').forEach(opt => {
    if (opt.dataset.lang === lang) {
      opt.classList.add('active');
    } else {
      opt.classList.remove('active');
    }
  });

  const dict = translations[lang] || translations.vi;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (dict[key]) {
      if (el.dataset.i18nHtml) {
        el.innerHTML = dict[key];
      } else {
        el.textContent = dict[key];
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const currentLang = localStorage.getItem('app_lang') || 'vi';
  
  document.querySelectorAll('.lang-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      const lang = opt.dataset.lang || (opt.textContent.trim().toLowerCase() === 'eng' ? 'en' : 'vi');
      setLanguage(lang);
    });
  });

  setLanguage(currentLang);
});
