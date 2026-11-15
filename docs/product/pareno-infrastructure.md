# Pareno 基础设施与域名说明

日期：2026-11-15。目的：避免 Cloudflare、Vercel、WordPress、Paddle 多套系统混在一起时失去控制面。

## 域名 `altn.vision`

| 用途 | 当前指向 | 说明 |
| --- | --- | --- |
| DNS / NS | WordPress.com | 域名 nameserver 仍在 WordPress.com |
| 根域 `altn.vision` | WordPress.com 站点 | 个人/品牌主站 |
| `www.altn.vision` | Vercel | 之前的个人网站部署 |
| `pareno.altn.vision` | Cloudflare Pages | Pareno 产品页（已生效） |
| `parenowriter.pages.dev` | Cloudflare Pages | 当前产品页与 appcast |
| 邮箱 MX | `smtp-fwd.wordpress.com` | 转发到 `archintera@outlook.com` |
| SPF | `include:spf.titan.email` | Titan 发信授权 |
| 支付 | Paddle（待接） | Merchant of Record |
| 桌面更新 | GitHub Releases + Pages appcast | Sparkle |

## 原则

1. **一个域名，多个子域，各司其职**，不要求所有东西都在同一个平台。
2. **DNS 只在一个地方管理**。现在是 WordPress.com；不要同时在 Cloudflare 和 WordPress 各改一半。
3. **不要为了统一而迁移正在工作的个人站**。迁移的风险大于收益。
4. **Pareno 用 Cloudflare Pages**：静态站免费、商业使用限制少，已经上线。
5. **个人站继续用 Vercel Hobby**：非商业个人项目合适；Vercel Hobby 不适合商业产品，商业项目要 Pro。
6. **邮箱先不动**：MX/SPF 正常就不要改；换 Google Workspace 前先列出现有邮箱和转发规则。

## 短期（现在）

- WordPress DNS 只加一条 `pareno` CNAME → `parenowriter.pages.dev`
- Cloudflare Pages 添加 `pareno.altn.vision`
- 不动根域、`www`、MX、SPF
- Vercel 个人站完全不动

## 中期（可选）

如果觉得 WordPress DNS 管多个平台太散，可以把 **DNS 托管**迁到 Cloudflare：

- 只迁 DNS，不迁网站
- 先完整导出/重建 A、CNAME、MX、TXT、SPF、DKIM、DMARC
- 切换 NS 前逐条核对
- 邮件和 Vercel 的 `www` 必须保持

这是“统一控制面”，不是“统一托管”。托管仍可以在 Vercel、Cloudflare、WordPress 各做各的。

## 不建议

- 为了“看起来统一”把 Pareno 迁到 Vercel Hobby（商业使用不合规）
- 为了加一个子域把整个域名 NS 切到 Cloudflare（容易漏 MX/SPF）
- 同时维护两套 DNS 记录
