# Pareno Desktop · 迭代计划（App Store 优先）

日期：2026-11-15。目标：先把**基础版**做完并上架 Mac App Store，再扩展 Pro/直发版。

## 0. 产品定位

> 给中/英/俄双语写作者的 macOS 写作检查器：贴着光标，检查、翻译、解释；模型可以完全在本地。

不做“又一个 Grammarly”。差异点是：光标 HUD、三合一动作、解释而不只改写、三语、本地/自带模型、Obsidian 同源。

## 1. 先做一个关键决定：双版本

Mac App Store 的沙盒限制决定了不能把“调用本机 Agent CLI”放进上架版。

### App Store 版（Pareno）

- 沙盒化
- 只使用 **Ollama HTTP**（本机，后续可选云端）
- 不执行 `codex` / `claude` / `cursor-agent` / `opencode`
- 三语 UI、检查/翻译/解释、结果卡、设置
- 免费下载，Pro 用非消耗型 IAP

### 直发版（Pareno Pro，后续）

- Developer ID + 公证 + DMG
- Agent CLI、云端模型、自动更新
- 给高级用户/自带订阅的人

> 上架版和直发版共享同一套核心代码，用 feature flag 区分能力。不要把 CLI 代码带进 App Store 构建。

## 2. App Store 基础版范围（v1.0）

### 必须有

- HUD：检查 / 翻译 / 解释，跟随光标或选区，设置里可关
- 结果卡：加载、错误、结果、替换/复制、缩放、避让输入法
- 三语 UI：中文 / English / Русский
- 设置：权限、模型、位置、自动隐藏、外观、Dock
- 首次启动引导：辅助功能 → Ollama → 拉一个模型 → 试一段
- 取消 / 超时 / 耗时显示
- 错误状态：没装 Ollama、没模型、模型太慢、无选区、权限拒绝
- 隐私说明：文本去哪里、是否离开本机
- App 图标、About、支持链接、隐私政策
- 50 条真实语料 QA（中/英/俄 × 检查/翻译/解释）
- App Store 沙盒、entitlements、隐私清单、截图、描述、审核备注

### 可以延后

- 卡片箭头（当前关闭；按 35×15 稿单独重做）
- Ollama Cloud
- Agent CLI
- 历史记录、术语表、自定义提示
- 自动更新（App Store 不需要）
- 订阅（先用买断 IAP 验证）

## 3. 阶段计划

### Phase 0 · 可行性 spike（3–5 天）

必须先验证，不能直接写两个月：

1. 开启 App Sandbox 后，Accessibility API 是否还能读取其他 App 的选区/光标？
2. 沙盒 App 能否访问 `http://localhost:11434`？
3. App Review 对“读取其他 App 文本 + 依赖 Ollama”的接受度；准备审核备注和先例（WunderType、Poli 等）。
4. 确定 App Store 版是否接受“必须安装 Ollama”；如果不接受，是否改用 Apple Foundation Models 做基础检查。

**Go/No-Go**：三项都通过 → App Store 优先；否则先直发 DMG，App Store 后置。

### Phase 1 · 基础质量（2 周）

- 安装 `qwen3.5:4b`，设为默认；`gemma4:12b` 备选
- 加载中显示秒数；取消按钮；150 秒超时改为 60–90 秒
- 30–50 条真实语料跑准确率/JSON 合法率/P50/P95
- 修所有 P0/P1：空文本关闭、权限、无模型、俄语布局
- 首次启动引导
- 应用图标 / About / 隐私说明

### Phase 2 · App Store 工程（1–2 周）

- App Sandbox + `com.apple.security.network.client`
- Accessibility 授权流程与审核备注
- 隐私清单（PrivacyInfo.xcprivacy）
- StoreKit 非消耗型 IAP（Pro）
- App Store Connect：bundle id、SKU、截图、描述、关键词、支持/隐私 URL
- TestFlight 构建

### Phase 3 · TestFlight / QA（1–2 周）

- 20 个测试者：中/英/俄、Obsidian、浏览器、Word、Slack
- 设备：Intel/Apple Silicon、macOS 14/15/26
- 场景：没装 Ollama、没模型、离线、权限拒绝、模型超时、长文本、输入法
- 崩溃/卡死/权限回归
- 审核预检：录屏、说明“为什么需要辅助功能”

### Phase 4 · 上架（1 周 + 审核等待）

- 提交审核
- 准备 Product Hunt / X / Reddit / Obsidian 社区 / 小红书
- 首发免费 + Pro 买断；收集前 50 个用户反馈

### Phase 5 · 上架后（持续）

- 箭头重做
- Ollama Cloud
- 直发 Pro（Agent CLI）
- 历史/术语表/自定义提示
- 订阅（只有持续服务成立时）

## 4. 时间线（乐观估计）

| 周 | 内容 |
| --- | --- |
| W1 | 可行性 spike、qwen 安装、取消/超时 |
| W2 | 真实语料 QA、引导、图标、隐私 |
| W3 | 沙盒、StoreKit、App Store Connect |
| W4 | TestFlight、修 P0 |
| W5 | 提交审核、市场素材 |
| W6+ | 审核往返、上线 |

现实预期：**6–10 周**，审核和沙盒问题可能再加 2–4 周。

## 5. 风险

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 沙盒下 Accessibility 不可用 | App Store 版做不了核心功能 | Phase 0 spike；不行就直发 |
| 审核认为“读取其他 App”不可接受 | 拒审 | 审核备注 + 先例 + 只读、不采集、不上传 |
| 依赖 Ollama 被拒 | 上架失败 | 引导安装 + 说明；或改用 Apple 本地模型 |
| 模型太慢 | 差评/退款 | 默认 qwen3.5:4b；超时/取消；模型推荐 |
| 30% 抽成 + IAP | 收入下降 | 买断定价覆盖；直发版保留 |
| 权限/签名回归 | 用户打不开 | 固定 Developer ID；上架版由 App Store 签名 |

## 6. 验收指标

- 首次启动 5 分钟内完成：权限 → 模型 → 第一次检查
- 检查/翻译/解释成功率 ≥ 95%（50 条语料）
- P50 延迟 ≤ 8 秒，P95 ≤ 25 秒（qwen3.5:4b）
- 崩溃-free ≥ 99.5%
- TestFlight 20 人中 ≥ 60% 完成一次真实替换
- 上架后 7 日留存 ≥ 20%

## 7. 现在就要做的 5 件事

1. **Phase 0 spike**：沙盒 + Accessibility + localhost Ollama + 审核预判
2. 安装 `qwen3.5:4b`，设为默认
3. 加取消/超时/耗时；空文本/无模型/权限错误全覆盖
4. 做首次启动引导 + 图标 + 隐私说明
5. 准备 50 条中/英/俄真实语料 QA

## 8. 需要你确认

1. Apple Developer Program / App Store Connect 是否已就绪？团队账号是哪个？
2. App Store 版可以接受**去掉 Agent CLI**吗？
3. 上架版定价：免费 + Pro 买断（$19.99），还是先完全免费？
4. 是否接受先做 3–5 天 spike，再决定 App Store 还是直发？
