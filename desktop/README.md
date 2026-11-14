# Pareno Desktop

PARENO 的桌面端口：像输入法候选条一样贴着光标，检查语法、用词与表达，并提供翻译。

A local-first macOS writing checker. Select text in any app, press **⌥⌘G**, and get grammar, vocabulary and expression fixes with a one-click replace.

Chinese and English are both supported. All text goes to your local Ollama; nothing is sent to a cloud service.

## Requirements

- macOS 13 or newer
- [Ollama](https://ollama.com) running locally (`ollama serve`)
- At least one model, for example `ollama pull qwen2.5:7b` (faster) or `gpt-oss:20b` (slower, more thorough)

## Build and run

```bash
./scripts/build-app.sh
open "Pareno Desktop.app"
```

The app lives in the menu bar (a `text.badge.checkmark` icon). It has no Dock icon.

## Permissions

1. On first launch, allow Pareno Desktop in **System Settings → Privacy & Security → Accessibility**.
2. Keep the app at a stable path; rebuilding from source can reset the permission because the ad-hoc signature changes.

## Use

While you type in any text field, a small pill follows the caret with three actions:

- **检查** — grammar, vocabulary and expression fixes
- **翻译** — Chinese ↔ English, with faithful and natural versions
- **解释** — why it is wrong, a corrected sentence, and an example; it never rewrites your text

Click any action, or select text and press **⌥⌘G**.

The pill sits directly above the text caret, like an input-method candidate bar. If an app does not expose caret bounds, it falls back to the focused text field, then to its last position. It stays visible while the result card is open.

Open **设置…** from the menu bar icon (⌘,) to control:

- show / hide the HUD
- appear while typing, while selecting text, or both
- follow the caret or stay at a fixed, draggable position
- hide after 1–8 seconds without typing
- follow the system appearance, or force dark / light
- show a Dock icon for easier relaunching

The pill has two docking modes as well:

- **吸附光标** — follows the text caret in any app (default).
- **固定位置（可拖动）** — stays where you drag it, and the position is remembered. Drag the small grip on the left edge of the pill.

Turn the pill off entirely with 显示光标小工具.

1. Select a sentence or paragraph in any app (Mail, Slack, browser, Word, Obsidian…).
2. Press **⌥⌘G** (or use the menu bar → 检查选区).
   The shortcut uses a Carbon global hotkey, so it fires even before Accessibility is granted; without permission the panel explains what to enable instead of staying silent.
3. Review the issues and the two versions: 最小修改 and 自然表达.
4. Click 替换选区 to write the improved text back, or 复制改进版.

Some apps expose their selection through the Accessibility API only partially. If nothing is selected, Pareno Desktop shows a hint instead of guessing.

## Command line

Useful for testing the engine without the UI:

```bash
./.build/debug/ParenoDesktop --models
./.build/debug/ParenoDesktop --check "I have a big wrong for expression in English."
```

## Model choice

`gpt-oss:20b` can take 60–100 seconds per check on a laptop. `qwen2.5:7b`, `gemma3:4b` or similar smaller models are much faster and usually enough for grammar and expression checks. Pick the model in the menu bar → 模型.

## Roadmap

- 线框阶段的「解释」按钮（为什么错、更自然的说法、例句）尚未进入代码，下一步实现。

- Stage 1 (this prototype): select text + global hotkey + replace.
- Stage 2: live inline underlines while typing (requires an event tap / input monitoring and a different permission model).
- Later: personal style memory, bilingual alternative phrasing, history.

## Privacy

- Text is sent only to `http://localhost:11434` (overridable with `PARENO_DESKTOP_OLLAMA`).
- No analytics, no accounts, no telemetry.
- The only data stored is the selected model name in `UserDefaults`.
