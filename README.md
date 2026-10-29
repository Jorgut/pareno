# PARENO｜并言

**Write. Refine. Learn.**

PARENO is an Obsidian bilingual writing companion by **ArchIntera** for Chinese–English translation, English editing, Chinese-language explanations, and reusable learning notes.

This repository contains a working first-version plugin, not a published Community Plugins listing.

## Features

- Review English with minimal corrections, natural rewrites, and an explanation of each proposed change.
- Translate Chinese ↔ English using the same selection workflow.
- Explain grammar and vocabulary in Simplified Chinese.
- Underline returned issue spans in the source editor: red for grammar, accent blue for style, warning color for wording.
- Apply a selected revision, insert a translation below its source, or keep the original. Obsidian's Undo reverses applied edits.
- Save notes to `PARENO/Learning Log.md` inside the vault.
- Optional automatic review of the current paragraph after a typing pause. **Off by default.**
- OpenAI-compatible Chat Completions endpoints and local Ollama support.
- Review your author voice for generic phrasing, repetitive transitions, and vague claims without guessing who wrote the text.
- Optionally scan the **entire current note** with the official Pangram text-detection API, then inspect its human / AI-assisted / AI-generated estimates and flagged text windows.

## Install in Obsidian

1. On GitHub, select **Code → Download ZIP** and unzip the repository.
2. Copy **`main.js`**, **`manifest.json`**, and **`styles.css`** to your vault's `.obsidian/plugins/pareno/` directory.
3. In Obsidian: **Settings → Community plugins → enable PARENO**.
4. Open its settings to choose a model provider.

The repository ZIP also includes the full TypeScript project. Only the three files above are required at runtime.

### Use Ollama locally (default)

Install [Ollama](https://ollama.com) separately, then download an instruction model such as:

```bash
ollama pull qwen2.5:7b
```

Run Ollama and keep the plugin endpoint as `http://localhost:11434/v1/chat/completions`, model `qwen2.5:7b`. The first model download requires internet access. The plugin does not install Ollama or a model.

### Use a hosted model

Choose **OpenAI-compatible API**, enter a Chat Completions endpoint, a model ID, and an API key. API access is billed separately from a ChatGPT subscription. Selected text is sent to your configured provider when you request an analysis. API keys are saved in your vault's plugin settings; do not publish or commit those settings.

### Review author voice and detect AI-assisted writing

**Author Voice** is a writing-quality review in PARENO. Select an English paragraph and click **作者风格** in the sidebar, or use the **Audit author voice** command. The configured writing model identifies specific generic claims, repetitive transitions, and weak detail. This is editorial feedback, **not an AI classifier**. PARENO does not generate a fake detection percentage or promise any particular outcome on Substack.

**Pangram Scan** calls Pangram's actual classification API. Obtain a separate API key and credits through [Pangram](https://www.pangram.com/pricing), then add the key in **Settings → Community plugins → PARENO → Pangram API key**. Open an Obsidian article, expand **Pangram · AI 文本检测** in the sidebar, and choose **检测整篇文章**. A scan is performed only when you click, and each request may incur Pangram charges. PARENO prepares the current note as article text (removing Markdown metadata and formatting), sends that text directly to Pangram, polls its task endpoint, and displays the real result and marked windows. It does not expose a public report link. The result might differ from the classifier or version used in the Substack Reader.

Substack's [official AI transparency help](https://support.substack.com/hc/en-us/articles/50891130623508-How-can-I-detect-AI-on-Substack) describes its Pangram integration, options for reporting false positives, and the creator's **How I make this** statement. Detector percentages are estimates and do not prove actual authorship.

## Everyday workflow

1. Select text in an Obsidian Markdown note. If nothing is selected, put the cursor in a paragraph.
2. Use the right-click editor menu, sidebar, or command palette: **PARENO: Review / Translate / Explain / Author voice review**.
3. Inspect the result in the sidebar. No text is replaced automatically.
4. Apply a minimal or natural revision, or insert the translated text beneath its source.
5. Save a learning card when a correction teaches you something useful.

You can assign shortcuts to these commands in **Settings → Hotkeys**. The ribbon language icon opens the sidebar.

## Development

Requires Node.js 20 or newer.

```bash
npm install
npm run typecheck
npm test
npm run build
```

`npm run dev` watches source files. The production bundle is `main.js` in the project root.

## Scope

This first version does **not** perform Word/DOCX import or export. That belongs to a later integration with the existing [`docx-forge`](https://github.com/Jorgut/docx-forge) workflow. It also does not install an Agent Skill: the plugin's writing instructions currently live in `src/core.ts` and may later be shared with a `PARENO Writing Skill`.

### Privacy and data handling

- By default, automatic review is disabled.
- Writing-model requests include only the selected text or current paragraph and task instructions, not the whole vault.
- Manual or automatic writing analysis sends text to the model provider configured in settings.
- Optional Pangram scans send the **whole current note** to Pangram only after clicking the scan button. They are not automatic, and are billed according to your Pangram API plan.
- The learning log stays inside the local vault unless the user syncs it.
- The plugin does not collect analytics or send background telemetry.

## License

MIT
