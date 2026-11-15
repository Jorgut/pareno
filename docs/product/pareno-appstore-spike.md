# App Store 可行性 Spike · Day 1

日期：2026-11-15。目标：验证沙盒版是否还能连接本机 Ollama，以及后续 Accessibility 是否可用。

## 已完成

- 新建 `desktop/ParenoDesktop.entitlements`
  - `com.apple.security.app-sandbox = true`
  - `com.apple.security.network.client = true`
- 复制当前 App，改为 `com.archintera.ParenoDesktop.Sandbox`，用 Developer ID 签名并嵌入 entitlements
- 直接运行沙盒版 CLI：

```text
./Pareno Desktop Sandbox.app/Contents/MacOS/ParenoDesktop --models
gpt-oss:20b
```

**结论：沙盒 + network.client 可以访问 `http://localhost:11434`。**

## 待验证

1. 沙盒版申请 Accessibility 后，能否读取 TextEdit / Chrome 的光标与选区。
2. App Review 对“读取其他 App 文本 + 依赖 Ollama”的接受度。
3. 若 AX 不可用，回退方案是直发公证 DMG，App Store 版改用 Apple Foundation Models 或内置 HTTP API。

## 签名团队

Keychain 里不止一个团队：

| 证书 | 团队/组织 |
| --- | --- |
| Apple Development: jorgutyn@yahoo.com | ALTAN JORGUTYN（团队 ID 与 MT6C6A292R 相关） |
| Apple Development: hong liang zhu | SMYDGL5D37 |
| Apple Distribution: hong liang zhu | GB38532D8G |
| Developer ID Application: hong liang zhu | GB38532D8G |

App Store 上架需要确认 `juhonl@163.com` 对应哪个 Team ID；当前分发证书使用的是 `GB38532D8G`。


## 已上架 App 的签名证据

之前上架的 **Kaloop**：

- 归档：`Kaloop-0.9.0.xcarchive`
- Bundle ID：`ArchIntera.Kaloop`
- Team：`GB38532D8G`
- SigningIdentity：`Apple Distribution: hong liang zhu (GB38532D8G)`
- Provisioning Profile：`Kaloop App Store 0.9.0`，TeamName `hong liang zhu`

QuietBar 归档同样是 `GB38532D8G`，使用 `Apple Development: hong liang zhu (SMYDGL5D37)` 归档。

**结论：已上架产品全部属于 hong liang zhu / GB38532D8G。**

ALTAN JORGUTYN 的 Apple Development 证书（MT6C6A292R / OU M2K27U7XJ4）是另一个 Apple ID 的免费/个人团队证书，没有付费开发者计划，不能用于 App Store 分发。它只是留在 Keychain 里，不影响已上架产品。


## 证书清理（2026-11-15）

已删除 ALTAN JORGUTYN 的 Apple Development 证书：

- 原 SHA-1：`92D3C5367A17B055194B57708D655D87178D519A`
- 公钥备份：`~/Documents/AppleCertBackups/altan-dev-cert.pem`
- 删除后 Keychain 只剩 5 个 hong liang zhu 的签名身份，全部属于 `GB38532D8G`
- 现有 provisioning profiles 也全部是 `GB38532D8G`

注意：私钥未备份，无法恢复签名；免费团队证书可按需重新生成。Xcode → Settings → Accounts 中如仍有 ALTAN 的 Apple ID，建议移除，避免自动重新生成。


## Day 1 Accessibility 测试结果（关键）

沙盒测试包已手动加入辅助功能，开关为 1，Touch ID 已确认。

实测：

- 沙盒 App 能启动、能显示 HUD、能访问 localhost Ollama
- 但按 ⌥⌘G 后，结果卡显示 “No text selected / No text to check”
- TextEdit 里有文字、光标也在正文，沙盒 App 读不到 AXValue / 选区
- 主 App（非沙盒）在同样场景下正常

**结论：当前“跨 App 读取光标/选区 + HUD”的架构在 App Sandbox 下不可用。**

这不是权限没开，而是沙盒隔离导致跨 App Accessibility 读取失败。Apple 文档也明确：不能沙盒化一个控制其他 App 的 assistive app。

## 对 App Store 路线的影响

现有架构不能直接上架。可选方案：

1. **App Store Lite**：不做跨 App 光标 HUD，改为 Services / 剪贴板 / 手动粘贴触发；保留检查/翻译/解释和三语。
2. **直发 DMG 优先**：保留完整 HUD 和 Agent CLI，先公证分发；App Store 版后续再做 Lite。
3. **entitlement 研究**：确认是否存在可被 App Review 接受的 Accessibility 临时例外；目前证据不支持。

建议：先直发，App Store 版重新设计为 Services/剪贴板触发，不再承诺“贴着光标”。
