import {
  Editor, EditorPosition, ItemView, MarkdownView, Notice, Plugin, PluginSettingTab,
  Setting, TFile, WorkspaceLeaf, normalizePath, requestUrl
} from 'obsidian';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import { StateEffect, StateField } from '@codemirror/state';
import {
  articleTextForDetection, buildMessages, CoachMode, CoachResult, PangramReport, flaggedPangramWindows,
  findIssueRanges, makeLearningMarkdown, parseCoachResponse, parsePangramReport,
  validateSelection
} from './core';

const PANEL_TYPE = 'pareno-panel';
const LOG_FOLDER = 'PARENO';
const LOG_PATH = `${LOG_FOLDER}/Learning Log.md`;

type Provider = 'ollama' | 'openai';
interface CoachSettings {
  provider: Provider;
  endpoint: string;
  model: string;
  apiKey: string;
  pangramApiKey: string;
  register: 'professional' | 'conversational' | 'podcast';
  autoReview: boolean;
  autoDelay: number;
}

const DEFAULT_SETTINGS: CoachSettings = {
  provider: 'ollama',
  endpoint: 'http://localhost:11434/v1/chat/completions',
  model: 'qwen2.5:7b',
  apiKey: '',
  pangramApiKey: '',
  register: 'professional',
  autoReview: false,
  autoDelay: 3000
};

interface TextContext {
  editor: Editor;
  view: MarkdownView;
  filePath: string;
  from: EditorPosition;
  to: EditorPosition;
  source: string;
}

interface Analysis {
  mode: CoachMode;
  context: TextContext;
  result: CoachResult;
  applied: boolean;
}

interface HighlightSpan { from: number; to: number; kind: 'grammar' | 'style' | 'wording' }
const setHighlights = StateEffect.define<HighlightSpan[]>();
const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    if (transaction.docChanged) value = Decoration.none;
    for (const effect of transaction.effects) {
      if (!effect.is(setHighlights)) continue;
      const spans = effect.value
        .filter(span => span.from >= 0 && span.to > span.from && span.to <= transaction.state.doc.length)
        .sort((a, b) => a.from - b.from);
      const decorations = spans.map(span => Decoration.mark({
        class: `bwc-inline-issue bwc-inline-${span.kind}`
      }).range(span.from, span.to));
      value = Decoration.set(decorations, true);
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field)
});

function getCodeMirrorView(editor: Editor): EditorView | undefined {
  // Obsidian's Editor interface does not expose its underlying CM6 instance in types.
  return (editor as Editor & { cm?: EditorView }).cm;
}

export default class ParenoPlugin extends Plugin {
  settings: CoachSettings = DEFAULT_SETTINGS;
  private analysis?: Analysis;
  private pendingMode?: CoachMode;
  private pendingContext?: TextContext;
  private errorMessage = '';
  private requestVersion = 0;
  private autoTimer?: ReturnType<typeof setTimeout>;
  private lastAutoSource = '';
  private pangramVersion = 0;
  private pangramPending = false;
  private pangramError = '';
  private pangramReport?: { filePath: string; source: string; report: PangramReport };

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.registerView(PANEL_TYPE, leaf => new CoachSidebar(leaf, this));
    this.registerEditorExtension([
      highlightField,
      EditorView.domEventHandlers({
        click: event => {
          const target = event.target;
          if (target instanceof Element && target.closest('.bwc-inline-issue')) {
            void this.showCachedPanel();
          }
          return false;
        }
      })
    ]);
    this.addRibbonIcon('languages', 'Open PARENO', () => { void this.openPanel(); });

    const commands: Array<{ mode: CoachMode; id: string; name: string }> = [
      { mode: 'review', id: 'review-selection', name: 'Review selected text / current paragraph' },
      { mode: 'translate', id: 'translate-selection', name: 'Translate selected text / current paragraph' },
      { mode: 'explain', id: 'explain-selection', name: 'Explain selected text / current paragraph' },
      { mode: 'voice', id: 'voice-audit-selection', name: 'Audit author voice in selected text / current paragraph' }
    ];
    for (const command of commands) {
      this.addCommand({
        id: command.id,
        name: command.name,
        editorCallback: (editor, view) => {
          if (!(view instanceof MarkdownView)) return;
          void this.analyze(command.mode, this.capture(editor, view));
        }
      });
    }
    this.addCommand({ id: 'open-sidebar', name: 'Open PARENO sidebar', callback: () => { void this.openPanel(); } });
    this.addCommand({ id: 'pangram-scan-note', name: 'Scan current note with Pangram AI detector', callback: () => { void this.scanCurrentNote(); } });

    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
      if (!(view instanceof MarkdownView)) return;
      menu.addItem(item => item.setTitle('PARENO: Review').setIcon('spell-check')
        .onClick(() => { void this.analyze('review', this.capture(editor, view)); }));
      menu.addItem(item => item.setTitle('PARENO: Translate').setIcon('languages')
        .onClick(() => { void this.analyze('translate', this.capture(editor, view)); }));
      menu.addItem(item => item.setTitle('PARENO: Explain').setIcon('book-open')
        .onClick(() => { void this.analyze('explain', this.capture(editor, view)); }));
      menu.addItem(item => item.setTitle('PARENO: Author voice review').setIcon('pen-line')
        .onClick(() => { void this.analyze('voice', this.capture(editor, view)); }));
    }));

    this.registerEvent(this.app.workspace.on('editor-change', (editor, view) => {
      if (!this.settings.autoReview || !(view instanceof MarkdownView)) return;
      if (this.autoTimer) clearTimeout(this.autoTimer);
      this.autoTimer = setTimeout(() => {
        this.autoTimer = undefined;
        if (!this.settings.autoReview) return;
        const context = this.capture(editor, view, true);
        if (!context || !/[a-z]/i.test(context.source) || this.pendingMode) return;
        const cacheKey = `${context.filePath}\u0000${context.source}`;
        if (cacheKey === this.lastAutoSource) return;
        this.lastAutoSource = cacheKey;
        void this.analyze('review', context, true);
      }, this.settings.autoDelay);
    }));

    this.addSettingTab(new CoachSettingsTab(this.app, this));
  }

  onunload(): void {
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.requestVersion++;
    this.pangramVersion++;
  }

  async saveSettings(): Promise<void> { await this.saveData(this.settings); }

  private capture(editor: Editor, view: MarkdownView, onlyParagraph = false): TextContext | undefined {
    const file = view.file;
    if (!file) return undefined;
    let from = editor.getCursor('from');
    let to = editor.getCursor('to');
    if (onlyParagraph || editor.getSelection().length === 0) {
      const cursor = editor.getCursor();
      let first = cursor.line;
      let last = cursor.line;
      if (!editor.getLine(cursor.line).trim()) return undefined;
      while (first > 0 && editor.getLine(first - 1).trim()) first--;
      while (last < editor.lineCount() - 1 && editor.getLine(last + 1).trim()) last++;
      from = { line: first, ch: 0 };
      to = { line: last, ch: editor.getLine(last).length };
    }
    const source = editor.getRange(from, to);
    return { editor, view, filePath: file.path, from, to, source };
  }

  async analyze(mode: CoachMode, context?: TextContext, silent = false): Promise<void> {
    if (silent && this.pendingMode) return;
    if (!context) {
      new Notice('Select text or place the cursor inside a paragraph.');
      return;
    }
    try { validateSelection(context.source); } catch (error) {
      if (!silent) new Notice((error as Error).message);
      return;
    }
    const version = ++this.requestVersion;
    this.clearHighlights(this.analysis?.context);
    this.analysis = undefined;
    this.pendingMode = mode;
    this.pendingContext = context;
    this.errorMessage = '';
    if (!silent) await this.openPanel();
    this.renderPanel();

    try {
      if (this.settings.provider === 'openai' && !this.settings.apiKey.trim()) {
        throw new Error('Add an API key in PARENO settings or use local Ollama.');
      }
      const response = await requestUrl({
        url: this.settings.endpoint.trim(),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.settings.provider === 'openai' ? { Authorization: `Bearer ${this.settings.apiKey.trim()}` } : {})
        },
        body: JSON.stringify({
          model: this.settings.model.trim(),
          messages: buildMessages(mode, context.source, this.settings.register),
          temperature: 0.2,
          stream: false
        })
      });
      if (version !== this.requestVersion) return;
      if (context.editor.getRange(context.from, context.to) !== context.source) {
        throw new Error('The paragraph changed during analysis. Select it again to review the latest text.');
      }
      const result = parseCoachResponse(response.json, context.source);
      this.analysis = { mode, context, result, applied: false };
      this.applyHighlights(context, result);
      this.errorMessage = '';
    } catch (error) {
      if (version !== this.requestVersion) return;
      this.errorMessage = error instanceof Error ? error.message : String(error);
      if (!silent) new Notice(this.errorMessage);
    } finally {
      if (version === this.requestVersion) {
        this.pendingMode = undefined;
        this.pendingContext = undefined;
        this.renderPanel();
      }
    }
  }

  private applyHighlights(context: TextContext, result: CoachResult): void {
    const view = getCodeMirrorView(context.editor);
    if (!view) return;
    const offset = context.editor.posToOffset(context.from);
    const spans = findIssueRanges(context.source, result.issues)
      .map(span => ({ from: span.from + offset, to: span.to + offset, kind: span.kind }));
    view.dispatch({ effects: setHighlights.of(spans) });
  }

  clearHighlights(context?: TextContext): void {
    const view = context && getCodeMirrorView(context.editor);
    if (view) view.dispatch({ effects: setHighlights.of([]) });
  }

  getAnalysis(): Analysis | undefined { return this.analysis; }
  private currentMarkdownView(): MarkdownView | undefined {
    return this.app.workspace.getActiveViewOfType(MarkdownView) ??
      this.app.workspace.getLeavesOfType('markdown')
        .map(leaf => leaf.view).find((view): view is MarkdownView => view instanceof MarkdownView);
  }
  getPangram(): { pending: boolean; error: string; result?: { filePath: string; source: string; report: PangramReport }; stale: boolean } {
    const result = this.pangramReport;
    const activeView = this.currentMarkdownView();
    return {
      pending: this.pangramPending, error: this.pangramError, result,
      stale: Boolean(result && (!activeView?.file || activeView.file.path !== result.filePath || articleTextForDetection(activeView.editor.getValue()) !== result.source))
    };
  }

  async scanCurrentNote(): Promise<void> {
    if (this.pangramPending) return;
    const view = this.currentMarkdownView();
    if (!view?.file) { new Notice('Open a Markdown note before scanning.'); return; }
    if (!this.settings.pangramApiKey.trim()) {
      new Notice('Add a Pangram API key in PARENO settings before running a paid scan.');
      return;
    }
    const source = articleTextForDetection(view.editor.getValue());
    if (source.trim().length < 100) { new Notice('Pangram needs a longer article for a useful scan.'); return; }
    if (source.length > 50000) { new Notice('Please scan a note containing 50,000 characters or fewer.'); return; }
    const version = ++this.pangramVersion;
    const filePath = view.file.path;
    this.pangramPending = true;
    this.pangramError = '';
    this.pangramReport = undefined;
    await this.openPanel();
    this.renderPanel();
    try {
      const headers = { 'Content-Type': 'application/json', 'x-api-key': this.settings.pangramApiKey.trim() };
      const created = await requestUrl({
        url: 'https://text.external-api.pangram.com/task',
        method: 'POST', headers,
        body: JSON.stringify({ text: source, public_dashboard_link: false })
      });
      const taskId: unknown = created.json?.task_id;
      if (typeof taskId !== 'string' || !/^[a-z\d-]{10,100}$/i.test(taskId)) {
        throw new Error('Pangram did not return a valid task ID.');
      }
      let completed = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise<void>(resolve => setTimeout(resolve, 1500));
        if (version !== this.pangramVersion) return;
        const response = await requestUrl({
          url: `https://text.external-api.pangram.com/task/${taskId}`,
          method: 'GET', headers: { 'x-api-key': this.settings.pangramApiKey.trim() }
        });
        if (response.json?.stage === 'STAGE_SUCCESS') {
          this.pangramReport = { filePath, source, report: parsePangramReport(response.json) };
          completed = true;
          break;
        }
        if (response.json?.stage === 'STAGE_FAILED') {
          throw new Error(`Pangram scan failed: ${String(response.json?.headline ?? 'unknown error')}`);
        }
      }
      if (!completed) throw new Error('Pangram scan timed out. Check your API dashboard before trying again.');
    } catch (error) {
      if (version !== this.pangramVersion) return;
      this.pangramError = error instanceof Error ? error.message : String(error);
      new Notice(this.pangramError);
    } finally {
      if (version === this.pangramVersion) {
        this.pangramPending = false;
        this.renderPanel();
      }
    }
  }
  getPending(): { mode?: CoachMode; context?: TextContext; error: string } {
    return { mode: this.pendingMode, context: this.pendingContext, error: this.errorMessage };
  }

  private getSidebar(): CoachSidebar | undefined {
    return this.app.workspace.getLeavesOfType(PANEL_TYPE)
      .map(leaf => leaf.view).find((view): view is CoachSidebar => view instanceof CoachSidebar);
  }

  private renderPanel(): void { this.getSidebar()?.render(); }

  async openPanel(): Promise<void> {
    let leaf: WorkspaceLeaf | undefined = this.app.workspace.getLeavesOfType(PANEL_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? undefined;
      if (!leaf) { new Notice('Unable to open the PARENO sidebar.'); return; }
      await leaf.setViewState({ type: PANEL_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    this.renderPanel();
  }

  async showCachedPanel(): Promise<void> { await this.openPanel(); }

  async rerun(mode: CoachMode): Promise<void> {
    const activeView = this.currentMarkdownView();
    const context = activeView && this.capture(activeView.editor, activeView)
      || this.analysis?.context || this.pendingContext;
    if (!context) { new Notice('Select a paragraph in the editor first.'); return; }
    await this.analyze(mode, context);
  }

  applyText(kind: 'minimal' | 'natural', insertBelow = false): boolean {
    const analysis = this.analysis;
    if (!analysis) return false;
    const { editor, from, to, source } = analysis.context;
    if (analysis.applied || editor.getRange(from, to) !== source) {
      new Notice('This text has changed. Run the check again before applying suggestions.');
      return false;
    }
    const replacement = analysis.result[kind];
    if (insertBelow) {
      editor.replaceRange(`\n\n${replacement}`, to, to);
    } else {
      editor.replaceRange(replacement, from, to);
    }
    analysis.applied = true;
    this.clearHighlights(analysis.context);
    this.renderPanel();
    new Notice('Applied. Use Obsidian Undo to reverse the change.');
    return true;
  }

  dismiss(): void {
    this.clearHighlights(this.analysis?.context);
    this.analysis = undefined;
    this.errorMessage = '';
    this.renderPanel();
  }

  async saveLearning(): Promise<void> {
    const analysis = this.analysis;
    if (!analysis) return;
    try {
      if (!this.app.vault.getAbstractFileByPath(LOG_FOLDER)) await this.app.vault.createFolder(LOG_FOLDER);
      const entry = makeLearningMarkdown(analysis.context.source, analysis.result, analysis.mode);
      const existing = this.app.vault.getAbstractFileByPath(LOG_PATH);
      if (existing instanceof TFile) await this.app.vault.append(existing, `\n${entry}`);
      else if (!existing) await this.app.vault.create(LOG_PATH, `# PARENO · Learning Log\n\n${entry}`);
      else throw new Error('The learning log path is occupied by a folder.');
      new Notice('Saved to PARENO/Learning Log.md');
    } catch (error) {
      new Notice(`Could not save the learning note: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

class CoachSidebar extends ItemView {
  private readonly coach: ParenoPlugin;
  constructor(leaf: WorkspaceLeaf, coach: ParenoPlugin) {
    super(leaf);
    this.coach = coach;
  }
  getViewType(): string { return PANEL_TYPE; }
  getDisplayText(): string { return 'PARENO'; }
  getIcon(): string { return 'languages'; }
  async onOpen(): Promise<void> { this.render(); }

  private action(parent: HTMLElement, label: string, callback: () => void, emphasis = false, disabled = false): void {
    const button = parent.createEl('button', { text: label, cls: emphasis ? 'mod-cta' : '' });
    button.disabled = disabled;
    button.addEventListener('click', callback);
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass('bwc-panel');
    root.createEl('h3', { text: 'PARENO · 并言' });
    root.createEl('p', { text: '中英写作 · 纠错 · 学习', cls: 'bwc-subtitle' });
    const analysis = this.coach.getAnalysis();
    const pending = this.coach.getPending();
    const tabs = root.createDiv({ cls: 'bwc-tabs' });
    for (const [mode, label] of [
      ['review', '纠错'], ['translate', '翻译'], ['explain', '解释'], ['voice', '作者风格']
    ] as Array<[CoachMode, string]>) {
      const button = tabs.createEl('button', { text: label });
      if ((pending.mode ?? analysis?.mode) === mode) button.addClass('bwc-tab-active');
      button.disabled = Boolean(pending.mode);
      button.addEventListener('click', () => { void this.coach.rerun(mode); });
    }
    this.renderPangram(root);
    if (pending.mode) {
      root.createEl('p', { text: '正在分析所选段落…', cls: 'bwc-status' });
      if (pending.context) this.section(root, '原文 Original', pending.context.source);
      return;
    }
    if (pending.error) root.createEl('p', { text: pending.error, cls: 'bwc-error' });
    if (!analysis) {
      root.createEl('p', { text: '在 Obsidian 编辑器中选中一段文字，使用纠错、翻译、解释或作者风格审阅。未选中时将处理光标所在段落。Pangram 可按需检测整篇文章。', cls: 'bwc-empty' });
      root.createEl('p', { text: '模型设置：Settings → Community plugins → PARENO。', cls: 'bwc-hint' });
      return;
    }
    this.section(root, '原文 Original', analysis.context.source);
    const { result, mode, applied } = analysis;
    if (mode === 'translate') {
      this.section(root, '忠实翻译 Faithful', result.minimal);
      this.section(root, '自然表达 Natural', result.natural);
    } else if (mode === 'review' || mode === 'voice') {
      this.section(root, mode === 'voice' ? '保留原声 Minimal change' : '最小修改 Minimal fix', result.minimal);
      this.section(root, mode === 'voice' ? '编辑建议 Editorial alternative' : '自然表达 Natural rewrite', result.natural);
    }
    if (result.explanation) this.section(root, '为什么这样写 Why', result.explanation);
    if (result.issues.length) {
      root.createEl('h4', { text: `修改依据 · ${result.issues.length}` });
      for (const issue of result.issues) {
        const item = root.createDiv({ cls: 'bwc-issue-card' });
        item.createEl('span', { text: issue.type.toUpperCase(), cls: `bwc-kind bwc-kind-${issue.type}` });
        item.createEl('div', { text: `${issue.source} → ${issue.replacement}`, cls: 'bwc-issue-change' });
        if (issue.reason) item.createEl('p', { text: issue.reason });
      }
    }
    const actions = root.createDiv({ cls: 'bwc-actions' });
    if (mode === 'review' || mode === 'voice') {
      this.action(actions, applied ? '已修改' : '应用最小修改', () => this.coach.applyText('minimal'), true, applied);
      this.action(actions, '采用自然表达', () => this.coach.applyText('natural'), false, applied);
    } else if (mode === 'translate') {
      this.action(actions, '在原文后插入译文', () => this.coach.applyText('natural', true), true, applied);
      this.action(actions, '替换所选原文', () => this.coach.applyText('natural'), false, applied);
    }
    this.action(actions, '保存学习卡片', () => { void this.coach.saveLearning(); });
    this.action(actions, '忽略建议', () => this.coach.dismiss());
    root.createEl('p', { text: '修改需要你确认。可使用 Obsidian 原生 Undo 撤销。', cls: 'bwc-hint' });
  }

  private renderPangram(root: HTMLElement): void {
    const panel = root.createEl('details', { cls: 'bwc-pangram' });
    panel.createEl('summary', { text: 'Pangram · AI 文本检测' });
    panel.createEl('p', {
      text: '检测当前整篇笔记。使用独立的 Pangram 付费 API 密钥，点击后才会上传正文。',
      cls: 'bwc-hint'
    });
    const detection = this.coach.getPangram();
    panel.open = detection.pending || Boolean(detection.error || detection.result);
    const scanButton = panel.createEl('button', {
      text: detection.pending ? 'Pangram 正在分析…' : '检测整篇文章',
      cls: 'bwc-scan-button'
    });
    scanButton.disabled = detection.pending;
    scanButton.addEventListener('click', () => { void this.coach.scanCurrentNote(); });
    if (detection.pending) panel.createEl('p', { text: '检测可能需要约 30 秒。', cls: 'bwc-status' });
    if (detection.error) panel.createEl('p', { text: detection.error, cls: 'bwc-error' });
    if (!detection.result) return;
    if (detection.stale) panel.createEl('p', {
      text: '文章已切换或修改。以下是上次扫描的结果，请重新检测最新稿件。', cls: 'bwc-error'
    });
    const { report } = detection.result;
    panel.createEl('div', { text: report.headline, cls: 'bwc-pangram-headline' });
    const stats = panel.createDiv({ cls: 'bwc-pangram-stats' });
    for (const [label, value] of [
      ['人工写作', report.fractionHuman], ['AI 辅助', report.fractionAssisted], ['AI 生成', report.fractionAI]
    ] as Array<[string, number]>) {
      const stat = stats.createDiv({ cls: 'bwc-pangram-stat' });
      stat.createEl('strong', { text: `${Math.round(value * 100)}%` });
      stat.createEl('span', { text: label });
    }
    if (report.prediction) panel.createEl('p', { text: report.prediction, cls: 'bwc-hint' });
    const flagged = flaggedPangramWindows(report);
    if (flagged.length) {
      panel.createEl('h4', { text: `Pangram 标记的片段 · ${flagged.length}` });
      for (const window of flagged.slice(0, 12)) {
        const item = panel.createDiv({ cls: 'bwc-issue-card' });
        item.createEl('span', { text: `${window.label}${window.confidence ? ` · ${window.confidence}` : ''}`, cls: 'bwc-kind bwc-kind-style' });
        item.createEl('p', { text: window.text.slice(0, 600) });
      }
      if (flagged.length > 12) panel.createEl('p', { text: `另有 ${flagged.length - 12} 个片段未展开。`, cls: 'bwc-hint' });
    }
    panel.createEl('p', {
      text: '以上比例为 Pangram 的分类估计，并非作者身份或创作过程的证明。PARENO 的「作者风格」审阅与该检测相互独立。',
      cls: 'bwc-hint'
    });
  }

  private section(parent: HTMLElement, title: string, body: string): void {
    const section = parent.createDiv({ cls: 'bwc-section' });
    section.createEl('div', { text: title, cls: 'bwc-section-label' });
    section.createEl('p', { text: body, cls: 'bwc-section-body' });
  }
}

class CoachSettingsTab extends PluginSettingTab {
  private readonly coach: ParenoPlugin;
  constructor(app: ParenoPlugin['app'], coach: ParenoPlugin) {
    super(app, coach);
    this.coach = coach;
  }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'PARENO · 并言' });
    new Setting(containerEl).setName('Provider').setDesc('Ollama stays on your computer. OpenAI sends selected text to your configured API endpoint.')
      .addDropdown(dropdown => dropdown.addOption('ollama', 'Ollama (local)').addOption('openai', 'OpenAI-compatible API')
        .setValue(this.coach.settings.provider).onChange(async value => {
          const provider = value as Provider;
          this.coach.settings.provider = provider;
          this.coach.settings.endpoint = provider === 'ollama'
            ? 'http://localhost:11434/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
          this.coach.settings.model = provider === 'ollama' ? 'qwen2.5:7b' : 'gpt-4.1-mini';
          await this.coach.saveSettings(); this.display();
        }));
    new Setting(containerEl).setName('API endpoint').setDesc('Chat Completions-compatible URL. Local Ollama defaults to port 11434.')
      .addText(text => text.setPlaceholder('https://.../v1/chat/completions').setValue(this.coach.settings.endpoint)
        .onChange(async value => { this.coach.settings.endpoint = value.trim(); await this.coach.saveSettings(); }));
    new Setting(containerEl).setName('Model').setDesc('The model ID available at your endpoint.')
      .addText(text => text.setValue(this.coach.settings.model)
        .onChange(async value => { this.coach.settings.model = value.trim(); await this.coach.saveSettings(); }));
    new Setting(containerEl).setName('API key').setDesc('Only used for OpenAI-compatible API mode. Stored in this vault’s plugin settings; avoid syncing keys to public repositories.')
      .addText(text => {
        text.inputEl.type = 'password';
        text.setPlaceholder('sk-...').setValue(this.coach.settings.apiKey)
          .onChange(async value => { this.coach.settings.apiKey = value.trim(); await this.coach.saveSettings(); });
      });
    new Setting(containerEl).setName('Pangram API key')
      .setDesc('Optional paid AI detection. PARENO only sends your current article to Pangram after you choose Scan. Stored locally in plugin settings; never commit this key.')
      .addText(text => {
        text.inputEl.type = 'password';
        text.setPlaceholder('Pangram API key').setValue(this.coach.settings.pangramApiKey)
          .onChange(async value => { this.coach.settings.pangramApiKey = value.trim(); await this.coach.saveSettings(); });
      });
    new Setting(containerEl).setName('Writing register').setDesc('Choose the preferred style for natural rewrites.')
      .addDropdown(dropdown => dropdown.addOption('professional', 'Professional').addOption('conversational', 'Conversational').addOption('podcast', 'Podcast script')
        .setValue(this.coach.settings.register).onChange(async value => {
          this.coach.settings.register = value as CoachSettings['register']; await this.coach.saveSettings();
        }));
    new Setting(containerEl).setName('Automatic paragraph review').setDesc('Off by default. When enabled, sends the current paragraph to your selected provider after you pause typing. It never edits text automatically.')
      .addToggle(toggle => toggle.setValue(this.coach.settings.autoReview).onChange(async value => {
        this.coach.settings.autoReview = value; await this.coach.saveSettings();
      }));
    new Setting(containerEl).setName('Auto-review delay (ms)').setDesc('Recommended: 3000 or more.')
      .addText(text => text.setValue(String(this.coach.settings.autoDelay)).onChange(async value => {
        const ms = Number(value);
        if (Number.isFinite(ms) && ms >= 1500 && ms <= 15000) {
          this.coach.settings.autoDelay = ms; await this.coach.saveSettings();
        }
      }));
    containerEl.createEl('p', { text: 'All AI requests send only the selected text or current paragraph, not your complete vault. The local provider requires Ollama and the selected model to be installed separately.', cls: 'setting-item-description' });
  }
}
