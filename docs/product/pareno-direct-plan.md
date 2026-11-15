# Pareno Desktop · 直发 DMG 与付费方案

日期：2026-11-15。决定：保留完整功能，**直发 DMG 优先**；App Store 完整版不做，App Store Lite 后置。

## 1. 结论

可以不上 App Store，直接在自己的官网 / GitHub Releases 分发 DMG，并在 App 内完成付费。

但要说清楚：

- **不能用 Apple 的 StoreKit 内购**（那是 App Store 专用）
- 可以用 **Paddle / Lemon Squeezy / Stripe** 的网页结账 + License Key
- 用户在 App 里点“升级 Pro” → 打开结账页 → 付款后拿到 License → App 自动激活
- 体验上仍然是“App 内付费”，只是底层走网页结账，不经过 Apple

## 2. 为什么直发更适合现在的 Pareno

- App Store 沙盒下，跨 App 读取光标/选区不可用（我们已实测）
- 完整 HUD、Agent CLI、云端模型都需要非沙盒能力
- 直发没有 30% 抽成，也不需要为了审核删功能
- 缺点是：没有 App Store 的发现/信任/安装便利，需要自己做官网、签名、公证、更新

## 3. 支付与 License

### 推荐：Paddle 或 Lemon Squeezy

| 方案 | 特点 | 适合 |
| --- | --- | --- |
| **Paddle** | Merchant of Record，代收 VAT/GST/销售税，License Key，订阅/买断 | 独立 macOS 软件，全球销售 |
| **Lemon Squeezy** | MoR，结账简单，License API 清晰 | 想快速上线的小团队 |
| **Stripe** | 费率低，但你是商户，要自己处理税务/退款 | 有税务/运营经验 |
| **Gumroad** | 最简单，费率较高 | 先验证需求 |

建议先用 **Paddle** 或 **Lemon Squeezy**，因为它们替你处理全球税务，并提供 license key 基础设施。

### 付费流程

1. App 内点「升级 Pro」
2. 打开 Paddle/LS Checkout（浏览器或内嵌 WebView）
3. 付款成功 → 平台发 License Key（邮件 + 成功页）
4. App 输入/自动接收 License
5. App 调平台 License API 激活，拿到签名 license 文件
6. License 存 Keychain；离线宽限 30 天，定期复验
7. 设备数限制 2–3 台，可在官网/账号页解绑

### 试用

- 14 天全功能试用，或 50 次动作
- 试用状态本地存 + 服务器校验，避免简单改时间
- 到期后保留只读/基础检查，不锁死用户数据

### 定价

- 首发价 **$19.99 买断**
- 常规价 **$24.99**
- 后续 Pro+（云端额度/团队）再考虑订阅

## 4. 分发与更新

### DMG

- Developer ID 签名
- Hardened Runtime
- **Notarization + staple**（当前 `spctl` 还是 rejected，必须先修）
- DMG 内放 App + Applications 快捷方式
- 官网 + GitHub Releases 双通道
- 提供 SHA-256

### 自动更新

- **Sparkle 2**
- EdDSA 签名 appcast
- 更新包同样要签名/公证
- 支持增量更新可选

### 首次启动

- 辅助功能：手动 `+` 添加，Touch ID 确认
- Ollama：检测/安装引导
- 模型：推荐 qwen3.5:4b
- 试用说明 + 隐私说明

## 5. 官网与信任

直发最大的短板是信任，必须补：

- 产品官网（定位、截图、演示视频、定价、FAQ）
- 隐私政策、EULA、退款政策
- 支持邮箱/文档
- 关于页显示版本、签名、更新日志
- 公证后的 DMG，避免“已损坏/未识别开发者”

## 6. 直发版功能范围

完整保留：

- 光标 HUD、检查/翻译/解释
- 本地 Ollama + 云端 + Agent CLI
- 三语 UI
- 历史、术语表、自定义提示（后续）
- 自动更新

不再受 App Store 沙盒限制。

## 7. 阶段计划

| 阶段 | 内容 | 时间 |
| --- | --- | --- |
| D0 | 修 notarization，出第一个可双击安装的 DMG | 2–3 天 |
| D1 | Sparkle 更新、关于页、SHA-256 | 2–3 天 |
| D2 | Paddle/LS 接入、License 激活、试用 | 1 周 |
| D3 | 首次启动引导、模型推荐、错误状态 | 1 周 |
| D4 | 30–50 条真实语料 QA + 5 人内测 | 1–2 周 |
| D5 | 官网/定价/演示视频/发布 | 1 周 |

现实预期：**4–6 周**可发布首个付费版。

## 8. 风险

| 风险 | 应对 |
| --- | --- |
| 未公证被 Gatekeeper 拦 | D0 必须修 |
| Paddle/LS 开户审核 | 提前注册，准备业务/税务信息 |
| License 被破解 | 签名 license + 服务端校验，不做过度 DRM |
| 用户不信任直发 | 官网、公证、退款政策、真实评价 |
| Ollama 依赖 | 引导安装 + 模型推荐 |
| 模型慢 | 默认 qwen3.5:4b，超时/取消 |
| App Store 缺失 | 后续做 Lite 版，或只做直发 |

## 9. 现在要做的事

1. 选支付平台：Paddle 还是 Lemon Squeezy
2. 修 notarization，产出可安装 DMG
3. 加 Sparkle 更新
4. 设计 License 激活/试用流程
5. 做首次启动引导
6. 准备官网和 5 人内测
