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
