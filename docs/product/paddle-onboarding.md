# Paddle 注册与接入清单

日期：2026-11-15。目标：用 Paddle 卖 Pareno Desktop，$19.99 买断，14 天试用。

## 0. 先决定

- 卖家身份：个人 / 个体 / 公司
- 收款方式：Payoneer / 银行电汇 / 其他
- 网站：https://parenowriter.pages.dev
- 产品：Pareno Desktop，macOS 软件，一次性 License

Paddle 的不支持国家名单里没有哈萨克斯坦；但个人卖家的提现路径仍需在注册时确认。

## 1. 注册入口

- 正式：https://vendors.paddle.com/signup
- 沙盒：https://sandbox-vendors.paddle.com/signup

建议先注册 **sandbox**，用于接入和测试；正式审核通过后再切 live。

## 2. 注册需要准备

- 邮箱、密码、邮箱验证
- 法定姓名、地址、国家
- 网站 URL
- 产品或业务描述
- 预计月销售额
- 身份证明（护照/身份证）
- 税务信息（非美国个人通常 W-8BEN）
- 收款账户（Payoneer/银行）

## 3. 网站必须先有的内容

Paddle 会做域名审核。现在 `parenowriter.pages.dev` 主要是 Obsidian 插件站，需要补：

- `/desktop`：Pareno Desktop 产品页
  - 功能：光标 HUD、检查/翻译/解释、三语、Ollama
  - 截图/演示
  - 系统要求：macOS 13+
  - 定价：$19.99 买断
  - 下载入口
- `/terms`：服务条款，包含 Paddle MoR 声明
- `/privacy`：隐私政策（本地/云端/Agent 数据去向）
- `/refund`：退款政策
- `/support`：支持邮箱
- 页脚放 Paddle 要求的 MoR 文案：

> Our order process is conducted by our online reseller Paddle.com. Paddle.com is the Merchant of Record for all our orders. Paddle provides all customer service inquiries and handles returns.

## 4. Paddle 产品配置

- Product：Pareno Desktop
- Type：Software / Desktop application
- Price：$19.99 USD，one-time
- Tax category：Software / electronically supplied
- Checkout：Paddle Checkout（overlay 或 hosted）
- 允许的支付方式：卡/PayPal 等默认
- 退款：按政策

拿到：

- `product_id`
- `price_id`
- `client-side token`
- sandbox/live API key

## 5. License 方案

**Paddle Billing 不原生提供域名绑定/激活次数管理**，需要自己或第三方做。

推荐：

1. Paddle Checkout → `transaction.completed` webhook
2. Cloudflare Worker 验签
3. 生成 Ed25519 签名的 License（含 product、email、txn、expiry）
4. 存入 KV/D1；通过成功页/邮件交付
5. App 调 Worker `/activate`，带 license + device id
6. Worker 返回签名 license；App 存 Keychain
7. 离线宽限 30 天；定期复验

第一版可以先“人工发 Key”验证付费，再自动化。

## 6. 接入顺序

1. 注册 sandbox
2. 建产品/价格
3. 网站补 `/desktop`、`/terms`、`/privacy`、`/refund`
4. 域名审核
5. Paddle Checkout 接入 App
6. Webhook + License Worker
7. 14 天试用
8. 正式账号审核 → 切 live

## 7. 现在要做的

- 你完成 Paddle sandbox 注册
- 我补网站产品页/条款/隐私/退款
- 拿到 sandbox product_id / price_id 后接 Checkout
