import {
  Editor, EditorPosition, ItemView, MarkdownView, Modal, Notice, Platform, Plugin, PluginSettingTab,
  Setting, TFile, WorkspaceLeaf, apiVersion, editorInfoField, normalizePath, requestUrl
} from 'obsidian';
import { EditorView } from '@codemirror/view';
import {
  articleTextForDetection, buildChatMessages, buildMessages, ChatResult, CoachMode, CoachResult,
  documentReviewBlocks, InlineIssue, makeInlineIssues, PangramReport, flaggedPangramWindows,
  makeLearningMarkdown, parseChatResponse, parseCoachResponse, parsePangramReport,
  validateSelection
} from './core';
import { createInlineReview } from './inline-review';
import { createTranslationPreview } from './translation-preview';
import { agentExecutable, Provider, requestWritingModel } from './provider';
import { spawn } from 'node:child_process';
import {
  agentDefinition, AgentKind, agentStatusLabel, agentStatusSummary, defaultAgentStatuses, AgentStatus,
  parseAgentVersion, resolveAgentCommand
} from './agents';
import {
  DEFAULT_OLLAMA_STATUS, hasOllamaCloudModel, hasOllamaModel, OLLAMA_CLOUD_KEYS_URL, OLLAMA_CLOUD_TAGS_URL,
  ollamaStatusLabel, parseOllamaCloudModels, parseOllamaModels, OllamaStatus
} from './ollama';
import {
  buildFeedbackCopyText, buildFeedbackDiagnostics, buildFeedbackIssueUrl, buildFeedbackSubmission,
  FEEDBACK_CATEGORIES, FeedbackCategory, FeedbackDraft, FeedbackEnvironment, FeedbackValidationError,
  feedbackCategoryLabel, isFeedbackDeliveryConfigured, MAX_FEEDBACK_MESSAGE, parseFeedbackDelivery,
  validateFeedbackDraft, describePlatform
} from './feedback';

const PANEL_TYPE = 'pareno-panel';
const LOG_FOLDER = 'PARENO';
const LOG_PATH = `${LOG_FOLDER}/Learning Log.md`;

interface CoachSettings {
  provider: Provider;
  endpoint: string;
  model: string;
  apiKey: string;
  ollamaApiKey: string;
  ollamaCloud: boolean;
  codexExecutable: string;
  claudeExecutable: string;
  cursorExecutable: string;
  opencodeExecutable: string;
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
  ollamaApiKey: '',
  ollamaCloud: false,
  codexExecutable: 'codex',
  claudeExecutable: 'claude',
  cursorExecutable: 'cursor-agent',
  opencodeExecutable: 'opencode',
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
  appliedDocument?: string;
}

export default class ParenoPlugin extends Plugin {
  settings: CoachSettings = DEFAULT_SETTINGS;
  private inline = createInlineReview(() => {
    if (this.analysis) {
      this.analysis.applied = true;
      this.analysis.appliedDocument = this.analysis.context.editor.getValue();
    }
    this.documentIssues = [];
    this.renderPanel();
  });
  private translationPreview = createTranslationPreview();
  private analysis?: Analysis;
  private documentIssues: InlineIssue[] = [];
  private documentEditor?: Editor;
  private scope: 'paragraph' | 'document' = 'paragraph';
  private messages: Array<{ role: 'user' | 'assistant'; content: string; revision?: string; source?: string;
    from?: EditorPosition; to?: EditorPosition; documentText?: string }> = [];
  private chatFilePath = '';
  private lastContext?: TextContext;
  private lastMarkdownView?: MarkdownView;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private chatBusy = false;
  private chatError = '';
  private pendingMode?: CoachMode;
  private pendingContext?: TextContext;
  private errorMessage = '';
  private requestVersion = 0;
  private chatRequestVersion = 0;
  private autoTimer?: ReturnType<typeof setTimeout>;
  private lastAutoSource = '';
  private pangramVersion = 0;
  private pangramPending = false;
  private pangramError = '';
  private pangramReport?: { filePath: string; source: string; report: PangramReport };
  private ollamaStatus: OllamaStatus = DEFAULT_OLLAMA_STATUS;
  private ollamaChecking = false;
  private ollamaStarting = false;
  private agentStatuses: AgentStatus[] = defaultAgentStatuses();
  private agentChecking = false;

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.lastMarkdownView = this.findActiveMarkdownView();
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      if (leaf?.view instanceof MarkdownView) this.lastMarkdownView = leaf.view;
    }));
    this.registerView(PANEL_TYPE, leaf => new CoachSidebar(leaf, this));
    this.registerEditorExtension([
      ...this.inline.extension,
      ...this.translationPreview.extension,
      EditorView.updateListener.of(update => {
        if (!update.selectionSet && !update.docChanged) return;
        const editor = update.state.field(editorInfoField, false)?.editor;
        const view = editor && this.app.workspace.getLeavesOfType('markdown')
          .map(leaf => leaf.view).find((item): item is MarkdownView => item instanceof MarkdownView && item.editor === editor);
        if (!editor || !view) return;
        this.lastContext = this.capture(editor, view);
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; this.renderPanel(); }, 250);
      })
    ]);
    this.addRibbonIcon('languages', 'Open PARENO', () => { void this.openPanel(); });

    const commands: Array<{ mode: CoachMode; id: string; name: string }> = [
      { mode: 'review', id: 'review-selection', name: 'Review selected text / current paragraph' },
      { mode: 'translate', id: 'translate-selection', name: 'Translate selected text / current paragraph' },
      { mode: 'compare', id: 'compare-bilingual-selection', name: 'Compare Chinese and English meaning in selection' },
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
    this.addCommand({ id: 'review-document', name: 'Review current article', editorCallback: (editor, view) => {
      if (view instanceof MarkdownView) void this.reviewDocument(editor, view);
    } });
    this.addCommand({ id: 'pangram-scan-note', name: 'Scan current note with Pangram AI detector', callback: () => { void this.scanCurrentNote(); } });

    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
      if (!(view instanceof MarkdownView)) return;
      menu.addItem(item => item.setTitle('PARENO: Review').setIcon('spell-check')
        .onClick(() => { void this.analyze('review', this.capture(editor, view)); }));
      menu.addItem(item => item.setTitle('PARENO: Translate').setIcon('languages')
        .onClick(() => { void this.analyze('translate', this.capture(editor, view)); }));
      menu.addItem(item => item.setTitle('PARENO: Review whole article').setIcon('file-search')
        .onClick(() => { void this.reviewDocument(editor, view); }));
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

    this.registerEvent(this.app.workspace.on('file-open', file => {
      if (file?.path === this.chatFilePath) { this.renderPanel(); return; }
      this.requestVersion++;
      this.chatRequestVersion++;
      this.pendingMode = undefined;
      this.pendingContext = undefined;
      this.errorMessage = '';
      this.chatBusy = false;
      this.chatError = '';
      if (this.analysis) this.inline.clear(this.analysis.context.editor);
      if (this.documentEditor) this.inline.clear(this.documentEditor);
      this.translationPreview.clear();
      this.messages = [];
      this.chatFilePath = file?.path ?? '';
      this.lastContext = undefined;
      this.analysis = undefined;
      this.documentIssues = [];
      this.documentEditor = undefined;
      this.renderPanel();
    }));

    this.addSettingTab(new CoachSettingsTab(this.app, this));
  }

  onunload(): void {
    if (this.autoTimer) clearTimeout(this.autoTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.requestVersion++;
    this.chatRequestVersion++;
    this.pangramVersion++;
  }

  async saveSettings(): Promise<void> { await this.saveData(this.settings); }

  getOllamaStatus(): OllamaStatus { return this.ollamaStatus; }
  isOllamaStarting(): boolean { return this.ollamaStarting; }
  hasOllamaModel(name: string): boolean { return hasOllamaModel(this.ollamaStatus.models, name); }
  getAgentStatuses(): AgentStatus[] { return this.agentStatuses; }
  isAgentsChecking(): boolean { return this.agentChecking; }

  async ensureAgentStatuses(force = false): Promise<AgentStatus[]> {
    const fresh = this.agentStatuses.every(status => status.checkedAt > 0 && Date.now() - status.checkedAt < 60000);
    if (!force && (this.agentChecking || fresh)) return this.agentStatuses;
    this.agentChecking = true;
    try {
      this.agentStatuses = await Promise.all((['codex', 'claude', 'cursor-agent', 'opencode'] as AgentKind[]).map(kind => this.probeAgent(kind)));
    } finally {
      this.agentChecking = false;
      this.renderPanel();
    }
    return this.agentStatuses;
  }

  private probeAgent(kind: AgentKind): Promise<AgentStatus> {
    const definition = agentDefinition(kind);
    const executable = resolveAgentCommand(agentExecutable(this.settings, kind));
    return new Promise(resolve => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (state: AgentStatus['state'], message = '', version = '') => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ kind, label: definition.label, executable, state, version, message, checkedAt: Date.now() });
      };
      let child;
      try {
        child = spawn(executable, definition.versionArgs, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      } catch {
        finish('missing');
        return;
      }
      timer = setTimeout(() => { child.kill(); finish('error', '检测超时'); }, 5000);
      child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
      child.on('error', () => finish('missing'));
      child.on('close', code => {
        const text = stdout.trim() || stderr.trim();
        if (code === 0) finish('ready', '', parseAgentVersion(text));
        else finish('error', text.slice(0, 160) || `${definition.label} 退出码 ${code}`, '');
      });
    });
  }

  private ollamaBase(): string {
    try { return new URL(this.settings.endpoint).origin; } catch { return 'http://localhost:11434'; }
  }

  async ensureOllamaStatus(force = false): Promise<OllamaStatus> {
    if (this.settings.provider !== 'ollama') return this.ollamaStatus;
    const fresh = this.ollamaStatus.checkedAt > 0 && Date.now() - this.ollamaStatus.checkedAt < 10000;
    if (!force && (this.ollamaChecking || fresh)) return this.ollamaStatus;
    this.ollamaChecking = true;
    try { await this.checkOllamaInternal(); } finally { this.ollamaChecking = false; }
    this.renderPanel();
    return this.ollamaStatus;
  }

  private async checkOllamaInternal(): Promise<void> {
    const [local, cloud] = await Promise.allSettled([
      requestUrl({ url: `${this.ollamaBase()}/api/tags`, method: 'GET', throw: false }),
      requestUrl({ url: OLLAMA_CLOUD_TAGS_URL, method: 'GET', throw: false })
    ]);
    const cloudOk = cloud.status === 'fulfilled' && cloud.value.status >= 200 && cloud.value.status < 300;
    const cloudModels = cloudOk ? parseOllamaCloudModels(cloud.value.json) : this.ollamaStatus.cloudModels;
    const cloudError = cloud.status === 'fulfilled'
      ? (cloudOk ? '' : `云端目录返回 ${cloud.value.status}`)
      : '无法连接 ollama.com';
    if (local.status === 'fulfilled') {
      const response = local.value;
      if (response.status >= 200 && response.status < 300) {
        this.ollamaStatus = { state: 'running', models: parseOllamaModels(response.json), cloudModels, cloudError, message: '', checkedAt: Date.now() };
      } else {
        this.ollamaStatus = { state: 'error', models: [], cloudModels, cloudError, message: `Ollama 返回 ${response.status}`, checkedAt: Date.now() };
      }
    } else {
      this.ollamaStatus = { state: 'stopped', models: [], cloudModels, cloudError, message: 'Ollama 未启动或端口不可用', checkedAt: Date.now() };
    }
  }

  private launchOllama(command: string, args: string[]): Promise<boolean> {
    return new Promise(resolve => {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
      let settled = false;
      const finish = (ok: boolean) => { if (settled) return; settled = true; resolve(ok); };
      child.once('error', () => finish(false));
      child.once('spawn', () => { child.unref(); finish(true); });
      setTimeout(() => finish(true), 1500);
    });
  }

  async startOllama(): Promise<void> {
    if (this.ollamaStarting) return;
    this.ollamaStarting = true;
    this.ollamaStatus = { state: 'stopped', models: [], cloudModels: this.ollamaStatus.cloudModels, cloudError: '', message: '正在启动 Ollama…', checkedAt: 0 };
    this.renderPanel();
    try {
      let launched = await this.launchOllama('ollama', ['serve']);
      if (!launched && process.platform === 'darwin') launched = await this.launchOllama('open', ['-a', 'Ollama']);
      if (!launched && process.platform === 'win32') launched = await this.launchOllama('cmd', ['/c', 'start', '', 'ollama', 'serve']);
      if (!launched) {
        this.ollamaStatus = { state: 'missing', models: [], cloudModels: [], cloudError: '', message: '未找到 Ollama，请先安装', checkedAt: Date.now() };
        new Notice('未找到 Ollama。请先安装 Ollama，或确认 ollama 命令在 PATH 中。');
        return;
      }
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise<void>(resolve => setTimeout(resolve, 500));
        await this.checkOllamaInternal();
        if (this.ollamaStatus.state === 'running') break;
      }
      if (this.ollamaStatus.state !== 'running') new Notice('Ollama 启动超时，请确认已安装并手动启动。');
    } finally {
      this.ollamaStarting = false;
      this.renderPanel();
    }
  }

  openOllamaDownload(): void { window.open('https://ollama.com/download', '_blank'); }
  openOllamaKeys(): void { window.open(OLLAMA_CLOUD_KEYS_URL, '_blank'); }

  async refreshOllamaModel(): Promise<void> {
    const status = await this.ensureOllamaStatus(true);
    if (this.settings.ollamaCloud) {
      if (status.cloudModels.length && !hasOllamaCloudModel(status, this.settings.model)) {
        const first = status.cloudModels[0];
        if (first) { this.settings.model = first; await this.saveSettings(); }
      }
      return;
    }
    if (status.state === 'running' && status.models.length && !hasOllamaModel(status.models, this.settings.model)) {
      const first = status.models[0];
      if (first) { this.settings.model = first; await this.saveSettings(); }
    }
  }

  openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  getFeedbackEnvironment(): FeedbackEnvironment {
    return {
      pluginVersion: this.manifest.version,
      obsidianVersion: apiVersion,
      platform: describePlatform(Platform),
      provider: this.settings.provider,
      model: this.settings.model,
      register: this.settings.register,
      autoReview: this.settings.autoReview
    };
  }

  openFeedback(): void { new FeedbackModal(this.app, this).open(); }

  async copyFeedbackDiagnostics(): Promise<void> {
    try {
      await navigator.clipboard.writeText(buildFeedbackDiagnostics(this.getFeedbackEnvironment()));
      new Notice('已复制环境信息，可粘贴到邮件或 GitHub Issue。');
    } catch {
      new Notice('无法访问剪贴板；请打开反馈窗口手动复制。');
    }
  }

  private capture(editor: Editor, view: MarkdownView, onlyParagraph = false): TextContext | undefined {
    const file = view.file;
    if (!file) return undefined;
    this.lastMarkdownView = view;
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
    this.translationPreview.clear();
    this.clearHighlights(this.analysis?.context);
    this.analysis = undefined;
    this.documentIssues = [];
    this.scope = 'paragraph';
    this.pendingMode = mode;
    this.pendingContext = context;
    this.errorMessage = '';
    if (!silent) await this.openPanel();
    this.renderPanel();

    try {
      const content = await requestWritingModel(this.settings, buildMessages(mode, context.source, this.settings.register), () => version !== this.requestVersion);
      if (version !== this.requestVersion) return;
      if (context.editor.getRange(context.from, context.to) !== context.source) {
        throw new Error('The paragraph changed during analysis. Select it again to review the latest text.');
      }
      const result = parseCoachResponse({ choices: [{ message: { content } }] }, context.source);
      this.analysis = { mode, context, result, applied: false };
      if (mode === 'review' || mode === 'voice') {
        const from = context.editor.posToOffset(context.from);
        const issues = makeInlineIssues({ text: context.source, from, to: from + context.source.length }, result, 'paragraph', 'paragraph');
        this.inline.set(context.editor, context.editor.getValue(), issues);
      }
      if (mode === 'translate' && (result.minimal || result.natural)) {
        const line = context.to.line;
        const to = context.editor.posToOffset({ line, ch: context.editor.getLine(line).length });
        this.translationPreview.show(context.editor, context.editor.getValue(), {
          from: context.editor.posToOffset(context.from),
          to,
          faithful: result.minimal,
          natural: result.natural
        }, (text, insertBelow) => {
          if (this.applyRevision(text, insertBelow)) this.translationPreview.clear(context.editor);
        });
      }
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

  clearHighlights(context?: TextContext): void {
    if (context) this.inline.clear(context.editor);
  }

  async reviewDocument(editor: Editor, view: MarkdownView): Promise<void> {
    if (!view.file) return;
    const source = editor.getValue();
    const path = view.file.path;
    const blocks = documentReviewBlocks(source);
    if (!blocks.length) { new Notice('当前文章没有可审校的英文段落。'); return; }
    if (blocks.length > 25) { new Notice('全文超过 25 个审校批次，请先分章节审校。'); return; }
    const version = ++this.requestVersion;
    this.translationPreview.clear();
    this.scope = 'document';
    this.analysis = undefined;
    this.documentIssues = [];
    this.documentEditor = editor;
    this.inline.clear(editor);
    this.pendingMode = 'review';
    this.pendingContext = undefined;
    this.errorMessage = `全文审校 0/${blocks.length}`;
    await this.openPanel();
    try {
      const issues: InlineIssue[] = [];
      for (const [index, block] of blocks.entries()) {
        if (version !== this.requestVersion || editor.getValue() !== source || view.file?.path !== path) throw new Error('已停止或原文改变；请重新审校。');
        this.errorMessage = `全文审校 ${index + 1}/${blocks.length}`;
        this.renderPanel();
        const content = await requestWritingModel(this.settings, buildMessages('review', block.text, this.settings.register), () => version !== this.requestVersion);
        if (version !== this.requestVersion || editor.getValue() !== source || view.file?.path !== path) throw new Error('已停止或原文改变；请重新审校。');
        const result = parseCoachResponse({ choices: [{ message: { content } }] }, block.text);
        issues.push(...makeInlineIssues(block, result, 'document', `document-${index}`));
      }
      this.documentIssues = issues;
      this.inline.set(editor, source, issues);
      this.errorMessage = '';
    } catch (error) {
      if (version === this.requestVersion) {
        this.errorMessage = error instanceof Error ? error.message : String(error);
        new Notice(this.errorMessage);
      }
    } finally {
      if (version === this.requestVersion) {
        this.pendingMode = undefined;
        this.renderPanel();
      }
    }
  }

  stopReview(): void {
    this.requestVersion++;
    this.pendingMode = undefined;
    this.pendingContext = undefined;
    this.errorMessage = '已停止本次审校。';
    this.renderPanel();
  }

  setScope(scope: 'paragraph' | 'document'): void { this.scope = scope; this.renderPanel(); }
  getScope(): 'paragraph' | 'document' { return this.scope; }
  getDocumentIssues(): InlineIssue[] { return this.documentEditor ? this.inline.getIssues(this.documentEditor) : []; }
  openIssue(id: string): boolean { return Boolean(this.documentEditor && this.inline.open(this.documentEditor, id)); }

  getAnalysis(): Analysis | undefined { return this.analysis; }
  private findActiveMarkdownView(): MarkdownView | undefined {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view) return view;
    const file = this.app.workspace.getActiveFile();
    if (!file) return undefined;
    return this.app.workspace.getLeavesOfType('markdown')
      .map(leaf => leaf.view)
      .find((item): item is MarkdownView => item instanceof MarkdownView && item.file?.path === file.path);
  }
  private currentMarkdownView(): MarkdownView | undefined {
    return this.findActiveMarkdownView() ?? this.lastMarkdownView;
  }
  getCurrentFilePath(): string | undefined { return this.currentMarkdownView()?.file?.path; }
  reviewActiveDocument(): void {
    const view = this.currentMarkdownView();
    if (view?.file) void this.reviewDocument(view.editor, view);
    else new Notice('请先打开一篇 Markdown 文章。');
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

  private renderPanel(): void {
    this.syncAnalysisApplied();
    this.getSidebar()?.render();
  }

  private syncAnalysisApplied(): void {
    const analysis = this.analysis;
    if (!analysis?.applied || !analysis.appliedDocument) return;
    const view = this.currentMarkdownView();
    if (!view || view.file?.path !== analysis.context.filePath) return;
    if (analysis.context.editor.getValue() !== analysis.appliedDocument) {
      analysis.applied = false;
      analysis.appliedDocument = undefined;
    }
  }

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
    return this.applyRevision(this.analysis?.result[kind] ?? '', insertBelow);
  }

  applyRevision(replacement: string, insertBelow = false): boolean {
    const analysis = this.analysis;
    if (!analysis) return false;
    const { editor, from, to, source } = analysis.context;
    if (this.currentMarkdownView()?.file?.path !== analysis.context.filePath) {
      new Notice('This text has changed. Run the check again before applying suggestions.');
      return false;
    }
    if (analysis.applied && analysis.appliedDocument === editor.getValue()) {
      new Notice('This suggestion is already applied. Undo to try another version.');
      return false;
    }
    if (editor.getRange(from, to) !== source) {
      new Notice('This text has changed. Run the check again before applying suggestions.');
      return false;
    }
    analysis.applied = false;
    analysis.appliedDocument = undefined;
    if (insertBelow) {
      editor.replaceRange(`\n\n${replacement}`, to, to);
    } else {
      editor.replaceRange(replacement, from, to);
    }
    analysis.applied = true;
    analysis.appliedDocument = editor.getValue();
    this.clearHighlights(analysis.context);
    this.translationPreview.clear();
    this.renderPanel();
    new Notice('Applied. Use Obsidian Undo to reverse the change.');
    return true;
  }

  dismiss(): void {
    this.translationPreview.clear();
    this.clearHighlights(this.analysis?.context);
    this.analysis = undefined;
    this.documentIssues = [];
    if (this.documentEditor) this.inline.clear(this.documentEditor);
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

  getChatMessages() { return this.messages; }
  getChatStatus() { return { busy: this.chatBusy, error: this.chatError }; }
  getCurrentContext(): TextContext | undefined {
    const previous = this.lastContext;
    if (previous && previous.view === this.currentMarkdownView() && previous.view.file?.path === previous.filePath &&
        previous.editor.getRange(previous.from, previous.to) === previous.source) return previous;
    const view = this.currentMarkdownView();
    return view ? this.capture(view.editor, view) : undefined;
  }

  async sendChat(instruction: string): Promise<void> {
    const context = this.getCurrentContext();
    if (!context || !instruction.trim()) { new Notice('请先在文章里选中内容，或把光标放在段落中。'); return; }
    try { validateSelection(context.source); } catch (error) { new Notice((error as Error).message); return; }
    if (this.chatBusy) return;
    if (this.chatFilePath !== context.filePath) { this.messages = []; this.chatFilePath = context.filePath; }
    this.chatBusy = true;
    this.chatError = '';
    const version = ++this.chatRequestVersion;
    const history = this.messages.map(message => ({ role: message.role, content: message.content }));
    this.messages.push({ role: 'user', content: instruction.trim(), source: context.source });
    this.renderPanel();
    try {
      const content = await requestWritingModel(this.settings, buildChatMessages(context.source, instruction.trim(), history), () => version !== this.chatRequestVersion);
      if (version !== this.chatRequestVersion) return;
      const result = parseChatResponse(content);
      this.messages.push({ role: 'assistant', content: result.reply + (result.explanation ? `\n\n${result.explanation}` : ''),
        revision: result.revision, source: context.source, from: context.from, to: context.to, documentText: context.editor.getValue() });
      await this.appendChatRecord(context.filePath, instruction.trim(), context.source, result);
    } catch (error) {
      if (version !== this.chatRequestVersion) return;
      this.chatError = error instanceof Error ? error.message : String(error);
      new Notice(this.chatError);
    } finally {
      if (version === this.chatRequestVersion) {
        this.chatBusy = false;
        this.renderPanel();
      }
    }
  }

  private async appendChatRecord(filePath: string, instruction: string, source: string, result: ChatResult): Promise<void> {
    const folder = 'PARENO/Conversations';
    if (!this.app.vault.getAbstractFileByPath(LOG_FOLDER)) await this.app.vault.createFolder(LOG_FOLDER);
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const filename = filePath.split('/').pop()?.replace(/\.md$/i, '').replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || 'Untitled';
    const hash = [...filePath].reduce((value, char) => ((value * 31) + char.charCodeAt(0)) >>> 0, 0).toString(16);
    const path = `${folder}/${filename}-${hash}.md`;
    const entry = `\n## ${new Date().toISOString()}\n\n**Article:** ${filePath}\n\n**Request:** ${instruction}\n\n**Source:**\n\n> ${source.replace(/\n/g, '\n> ')}\n\n**Reply:** ${result.reply}\n\n**Revision:**\n\n> ${(result.revision || 'No revision').replace(/\n/g, '\n> ')}\n\n**Explanation:** ${result.explanation || '—'}\n`;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.append(existing, entry);
    else if (!existing) await this.app.vault.create(path, `# PARENO · ${filename}\n${entry}`);
  }

  applyChatRevision(index: number): boolean {
    const message = this.messages[index];
    const view = this.currentMarkdownView();
    if (!message?.revision || !message.source || !message.from || !message.to || !view ||
        view.file?.path !== this.chatFilePath || view.editor.getValue() !== message.documentText ||
        view.editor.getRange(message.from, message.to) !== message.source) {
      new Notice('原文已改变，请重新审校后再采用修改稿。'); return false;
    }
    view.editor.replaceRange(message.revision, message.from, message.to);
    message.revision = undefined;
    this.renderPanel();
    new Notice('已替换，可使用 Obsidian 撤销。');
    return true;
  }
}

class CoachSidebar extends ItemView {
  private readonly coach: ParenoPlugin;
  private selectedMode: CoachMode = 'review';
  private draft = '';
  private settingsExpanded = false;
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
    const previousScroll = root.querySelector('.pareno-body')?.scrollTop ?? 0;
    root.empty();
    root.addClass('bwc-panel');
    const header = root.createDiv({ cls: 'pareno-header' });
    header.createEl('h3', { text: 'PARENO 并言' });
    header.createEl('span', { text: 'ARCHINTERA' });
    header.createEl('p', { text: '在正文里写，在侧栏里判断。' });
    const body = root.createDiv({ cls: 'pareno-body' });
    if (this.coach.settings.provider === 'ollama') void this.coach.ensureOllamaStatus();
    const analysis = this.coach.getAnalysis();
    const pending = this.coach.getPending();
    const context = this.coach.getCurrentContext();
    const current = body.createDiv({ cls: 'pareno-current' });
    current.createEl('strong', { text: '当前选区 / 段落' });
    current.createEl('span', { text: (context?.filePath ?? this.coach.getCurrentFilePath())?.split('/').pop() ?? '请打开文章' });
    current.createEl('p', { text: context?.source.slice(0, 220) || '在正文中选中文字，或把光标放在有文字的段落里。' });

    const documentIssues = this.coach.getDocumentIssues();
    const hasResult = Boolean(analysis || documentIssues.length);
    if (analysis) this.renderAnalysis(body, analysis);
    else if (documentIssues.length) this.renderDocumentIssues(body, documentIssues);

    const settings = body.createEl('details', { cls: 'pareno-settings' });
    settings.open = !hasResult || this.settingsExpanded || Boolean(pending.mode);
    const summary = settings.createEl('summary', { text: hasResult ? '审校设置 · 展开重新审校' : '审校设置' });
    summary.addEventListener('click', () => { this.settingsExpanded = !settings.open; });
    this.renderSettings(settings, context, pending);

    const history = body.createDiv({ cls: 'pareno-chat-history' });
    history.createEl('h4', { text: '写作对话' });
    for (const [index, message] of this.coach.getChatMessages().entries()) {
      const bubble = history.createDiv({ cls: `pareno-chat-message pareno-chat-${message.role}` });
      bubble.createEl('p', { text: message.content });
      if (message.revision) {
        const edited = bubble.createEl('textarea', { attr: { 'aria-label': '可编辑的修改稿' } });
        edited.value = message.revision;
        this.action(bubble, '确认并替换原文', () => { message.revision = edited.value; this.coach.applyChatRevision(index); }, true);
      }
    }
    const chat = this.coach.getChatStatus();
    if (chat.busy) history.createEl('p', { text: '正在思考…', cls: 'bwc-status' });
    if (chat.error) history.createEl('p', { text: chat.error, cls: 'bwc-error' });
    this.renderPangram(body);

    const composer = root.createDiv({ cls: 'pareno-composer' });
    const input = composer.createEl('textarea', { attr: { placeholder: '继续追问这段文字，或说说你想怎样改…', 'aria-label': '写作对话输入' } });
    input.value = this.draft;
    input.oninput = () => { this.draft = input.value; };
    input.onkeydown = event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); send(); } };
    const send = () => { const value = input.value.trim(); if (!value) return; this.draft = ''; void this.coach.sendChat(value); };
    const sendButton = composer.createEl('button', { text: chat.busy ? '发送中…' : '发送 ↗', cls: 'mod-cta' });
    sendButton.disabled = chat.busy;
    sendButton.onclick = send;
    composer.createEl('small', { text: '⌘ / Ctrl + Enter 发送 · 修改需确认 · 对话记录保存在本库' });
    const footer = root.createDiv({ cls: 'pareno-footer' });
    footer.createEl('span', { text: `v${this.coach.manifest.version}` });
    const feedback = footer.createEl('button', { text: '反馈问题 ↗', cls: 'pareno-feedback-link' });
    feedback.setAttribute('aria-label', '打开反馈问题窗口');
    feedback.onclick = () => this.coach.openFeedback();
    body.scrollTop = previousScroll;
  }

  private renderDocumentIssues(parent: HTMLElement, documentIssues: InlineIssue[]): void {
    const result = parent.createDiv({ cls: 'pareno-result-area' });
    result.createEl('h4', { text: `${documentIssues.length} 处建议 · 点击定位到正文` });
    for (const issue of documentIssues) {
      const button = result.createEl('button', { text: `${issue.kind === 'grammar' ? '明确错误' : '可选表达'} · ${issue.quote.slice(0, 90)}`, cls: 'pareno-result-item' });
      button.onclick = () => this.coach.openIssue(issue.id);
    }
  }

  private renderAnalysis(parent: HTMLElement, analysis: Analysis): void {
    const result = parent.createDiv({ cls: 'pareno-result-area' });
    const { result: analysisResult, mode, applied } = analysis;
    if (mode !== 'explain' && mode !== 'compare') {
      for (const [label, value, insertBelow] of [
        [mode === 'translate' ? '忠实翻译' : '最小修改', analysisResult.minimal, mode === 'translate'],
        [mode === 'translate' ? '自然译法' : '自然表达', analysisResult.natural, mode === 'translate']
      ] as Array<[string, string, boolean]>) {
        const section = result.createDiv({ cls: 'bwc-section' });
        section.createEl('div', { text: label, cls: 'bwc-section-label' });
        const edited = section.createEl('textarea', { attr: { 'aria-label': `${label}修改稿` } });
        edited.value = value;
        if (mode === 'translate') {
          const actions = section.createDiv({ cls: 'bwc-actions' });
          this.action(actions, '替换原文', () => this.coach.applyRevision(edited.value, false), false, applied);
          this.action(actions, '在原文后插入', () => this.coach.applyRevision(edited.value, true), true, applied);
        } else {
          this.action(section, insertBelow ? '在原文后插入' : '确认并替换原文', () => this.coach.applyRevision(edited.value, insertBelow), true, applied);
        }
      }
    }
    if (analysisResult.explanation) this.section(result, '修改依据 / Explanation', analysisResult.explanation);
    for (const issue of analysisResult.issues) {
      const item = result.createDiv({ cls: 'bwc-issue-card' });
      item.createEl('span', { text: issue.type === 'grammar' ? '明确错误' : '可选表达', cls: `bwc-kind bwc-kind-${issue.type}` });
      item.createEl('div', { text: `${issue.source} → ${issue.replacement}`, cls: 'bwc-issue-change' });
      if (issue.reason) item.createEl('p', { text: issue.reason });
    }
    const actions = result.createDiv({ cls: 'bwc-actions' });
    this.action(actions, '保存学习卡片', () => { void this.coach.saveLearning(); });
    this.action(actions, '忽略建议', () => this.coach.dismiss());
  }

  private renderSettings(parent: HTMLElement, context: TextContext | undefined, pending: { mode?: CoachMode; error: string }): void {
    parent.createEl('div', { text: '01 / 检查范围', cls: 'pareno-step' });
    const scopes = parent.createDiv({ cls: 'pareno-scope' });
    for (const [scope, label] of [['paragraph', '选区 / 当前段落'], ['document', '整篇文章']] as const) {
      const button = scopes.createEl('button', { text: label });
      if (this.coach.getScope() === scope) button.addClass('is-active');
      button.onclick = () => this.coach.setScope(scope);
    }

    parent.createEl('div', { text: '02 / 我想做什么', cls: 'pareno-step' });
    const tasks = parent.createDiv({ cls: 'pareno-tasks' });
    for (const [mode, label, detail] of [
      ['review', '检查与润色', '错误 + 可选表达'],
      ['translate', '翻译', '忠实 / 自然两版'],
      ['compare', '核对中英', '原意与证据强度'],
      ['explain', '解释表达', '语法与复用句型'],
      ['voice', '作者风格', '保留个人声音']
    ] as Array<[CoachMode, string, string]>) {
      const button = tasks.createEl('button');
      button.createEl('strong', { text: label });
      button.setAttribute('title', detail);
      button.setAttribute('aria-label', `${label}：${detail}`);
      if (this.selectedMode === mode) button.addClass('is-active');
      button.onclick = () => { this.selectedMode = mode; this.render(); };
    }

    const model = parent.createDiv({ cls: 'pareno-model' });
    model.createEl('span', { text: '模型与数据范围' });
    const statuses = this.coach.getAgentStatuses();
    if (statuses.some(status => status.state === 'unknown')) void this.coach.ensureAgentStatuses().then(() => this.render());
    const select = model.createEl('select', { attr: { 'aria-label': '模型供应方式' } });
    select.createEl('option', { text: 'Ollama · 本机 / 云端', value: 'ollama' });
    for (const status of statuses) {
      const suffix = status.state === 'ready' ? ' · 可用' : status.state === 'unknown' ? ' · 检测中' : '';
      select.createEl('option', { text: `${status.label}${suffix}`, value: status.kind });
    }
    select.createEl('option', { text: '云端 · 兼容 API', value: 'openai' });
    select.value = this.coach.settings.provider;
    select.onchange = () => {
      const provider = select.value as Provider;
      const previous = this.coach.settings.provider;
      this.coach.settings.provider = provider;
      if (provider === 'ollama') {
        this.coach.settings.endpoint = 'http://localhost:11434/v1/chat/completions';
        this.coach.settings.ollamaCloud = false;
        this.coach.settings.model = 'qwen2.5:7b';
      } else if (provider === 'openai' && this.coach.settings.endpoint.startsWith('http://localhost:')) {
        this.coach.settings.endpoint = 'https://api.openai.com/v1/chat/completions';
        this.coach.settings.model = 'gpt-4.1-mini';
      } else if (previous !== provider) {
        this.coach.settings.model = '';
      }
      void this.coach.saveSettings().then(() => this.render());
    };

    if (this.coach.settings.provider === 'ollama') {
      const ollamaStatus = this.coach.getOllamaStatus();
      const cloud = this.coach.settings.ollamaCloud;
      const ollama = parent.createDiv({ cls: 'pareno-ollama' });
      ollama.createEl('p', { text: ollamaStatusLabel(ollamaStatus, this.coach.settings.model, cloud), cls: 'pareno-ollama-status' });
      const localNames = [...new Set([...ollamaStatus.models, !cloud ? this.coach.settings.model : ''].filter(Boolean))];
      const cloudNames = [...new Set([...ollamaStatus.cloudModels, cloud ? this.coach.settings.model : ''].filter(Boolean))];
      if (localNames.length || cloudNames.length) {
        const modelRow = ollama.createDiv({ cls: 'pareno-ollama-models' });
        const modelSelect = modelRow.createEl('select', { attr: { 'aria-label': 'Ollama 模型' } });
        for (const name of localNames) modelSelect.createEl('option', { text: `本机 · ${name}`, value: `local:${name}` });
        for (const name of cloudNames) modelSelect.createEl('option', { text: `云端 · ${name}`, value: `cloud:${name}` });
        if (this.coach.settings.model) modelSelect.value = `${cloud ? 'cloud' : 'local'}:${this.coach.settings.model}`;
        modelSelect.onchange = () => {
          const separator = modelSelect.value.indexOf(':');
          this.coach.settings.ollamaCloud = modelSelect.value.slice(0, separator) === 'cloud';
          this.coach.settings.model = modelSelect.value.slice(separator + 1);
          void this.coach.saveSettings();
        };
      } else if (ollamaStatus.state === 'running') {
        ollama.createEl('p', { text: '还没有安装本机模型，也没有读取到云端目录。', cls: 'bwc-hint' });
      }
      if (cloud && !this.coach.settings.ollamaApiKey.trim()) {
        ollama.createEl('p', { text: '云端模型需要 ollama.com API 密钥，请在设置中填写。', cls: 'bwc-hint' });
      }
      const ollamaActions = ollama.createDiv({ cls: 'pareno-ollama-actions' });
      if (ollamaStatus.state !== 'running') {
        const start = ollamaActions.createEl('button', { text: this.coach.isOllamaStarting() ? '正在启动…' : '启动 Ollama', cls: 'mod-cta' });
        start.disabled = this.coach.isOllamaStarting();
        start.onclick = () => void this.coach.startOllama();
      }
      const refresh = ollamaActions.createEl('button', { text: '刷新' });
      refresh.onclick = () => void this.coach.ensureOllamaStatus(true);
      if (ollamaStatus.state === 'missing') {
        const install = ollamaActions.createEl('button', { text: '安装 Ollama' });
        install.onclick = () => this.coach.openOllamaDownload();
      }
    } else if (this.coach.settings.provider !== 'openai') {
      const status = statuses.find(item => item.kind === this.coach.settings.provider);
      const agent = parent.createDiv({ cls: 'pareno-ollama' });
      agent.createEl('p', { text: status ? agentStatusLabel(status) : '正在检测本机 Agent…', cls: 'pareno-ollama-status' });
      if (status && status.state !== 'ready') {
        agent.createEl('p', { text: '在设置中确认该 CLI 的路径，或安装后重新检测。', cls: 'bwc-hint' });
      }
      const open = agent.createEl('button', { text: '打开设置' });
      open.onclick = () => this.coach.openSettings();
    }

    const startLabels: Record<CoachMode, string> = {
      review: '开始检查', translate: '开始翻译', compare: '开始核对', explain: '开始解释', voice: '开始风格审阅'
    };
    const start = parent.createEl('button', {
      text: pending.mode ? '正在处理…' : this.coach.getScope() === 'document' ? '开始全文审校' : startLabels[this.selectedMode],
      cls: 'pareno-start'
    });
    start.disabled = Boolean(pending.mode);
    start.onclick = () => {
      if (this.coach.getScope() === 'document') {
        if (this.selectedMode !== 'review') { new Notice('全文范围目前支持“检查与润色”；其他任务请先选中段落。'); return; }
        this.coach.reviewActiveDocument();
      } else if (context) void this.coach.analyze(this.selectedMode, context);
      else new Notice('请先打开文章并把光标放在段落中。');
    };
    const provider = this.coach.settings.provider;
    const local = provider === 'ollama' && !this.coach.settings.ollamaCloud;
    const destination = local ? '本机 Ollama'
      : provider === 'ollama' ? 'Ollama 云端'
        : provider === 'openai' ? '所选云端 API' : '所选本机 Agent 的云服务';
    const whole = this.coach.getScope() === 'document';
    parent.createEl('p', { text: whole
      ? `全文将分批发送至${destination}；须主动点击开始。`
      : `只发送选区或当前段落至${destination}。`, cls: 'bwc-hint' });

    if (pending.mode) {
      parent.createEl('p', { text: pending.error || '正在分析所选段落…', cls: 'bwc-status' });
      this.action(parent, '停止本次审校', () => this.coach.stopReview());
    }
    if (pending.error && !pending.mode) parent.createEl('p', { text: pending.error, cls: 'bwc-error' });
    if (whole && !pending.mode) {
      parent.createEl('p', { text: '全文审校后，逐处建议会列在结果区，并映射到正文。', cls: 'bwc-hint' });
    }
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
    if (!this.coach.settings.pangramApiKey.trim()) {
      const configure = panel.createEl('button', { text: '配置 Pangram API Key', cls: 'bwc-scan-button' });
      configure.addEventListener('click', () => this.coach.openSettings());
    }
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

class FeedbackModal extends Modal {
  private readonly coach: ParenoPlugin;
  private category: FeedbackCategory = 'bug';
  private message = '';
  private email = '';
  private sending = false;
  private messageInput?: HTMLTextAreaElement;
  private counterEl?: HTMLElement;
  private statusEl?: HTMLElement;
  private submitButton?: HTMLButtonElement;

  constructor(app: ParenoPlugin['app'], coach: ParenoPlugin) {
    super(app);
    this.coach = coach;
  }

  onOpen(): void {
    const environment = this.coach.getFeedbackEnvironment();
    const configured = isFeedbackDeliveryConfigured();
    const { contentEl } = this;
    contentEl.addClass('pareno-feedback-modal');
    this.titleEl.setText('反馈问题 · PARENO');
    contentEl.createEl('p', {
      text: configured
        ? '描述你遇到的问题或建议。提交后会发送到作者的私有收件库，不会公开，也不会自动附带笔记内容、文件路径或 API 密钥。'
        : '反馈提交尚未配置；你可以复制反馈内容，或到 GitHub 提交公开 issue。',
      cls: 'pareno-feedback-intro'
    });

    const form = contentEl.createDiv({ cls: 'pareno-feedback-form' });
    const categoryField = form.createEl('label', { cls: 'pareno-feedback-field' });
    categoryField.createEl('span', { text: '反馈类型' });
    const category = categoryField.createEl('select', { attr: { 'aria-label': '反馈类型' } });
    for (const option of FEEDBACK_CATEGORIES) category.createEl('option', { value: option.value, text: option.label });
    category.value = this.category;
    category.onchange = () => { this.category = category.value as FeedbackCategory; };

    const messageField = form.createEl('label', { cls: 'pareno-feedback-field' });
    messageField.createEl('span', { text: '问题描述' });
    const message = messageField.createEl('textarea', {
      attr: {
        placeholder: '例如：全文审校到第 3 段时提示「已停止或原文改变」，但原文没有修改。\n\n复现步骤：…\n期望结果：…',
        'aria-label': '反馈问题描述',
        maxlength: String(MAX_FEEDBACK_MESSAGE)
      }
    });
    message.value = this.message;
    const counter = messageField.createEl('small', { cls: 'pareno-feedback-counter' });
    const updateCounter = () => { counter.textContent = `${[...message.value].length} / ${MAX_FEEDBACK_MESSAGE}`; };
    updateCounter();
    message.oninput = () => { this.message = message.value; updateCounter(); this.setStatus(''); };

    const emailField = form.createEl('label', { cls: 'pareno-feedback-field' });
    emailField.createEl('span', { text: '联系邮箱（选填）' });
    const email = emailField.createEl('input', {
      attr: { type: 'email', placeholder: 'you@example.com', autocomplete: 'off', maxlength: '254', 'aria-label': '联系邮箱（选填）' }
    });
    email.value = this.email;
    email.oninput = () => { this.email = email.value; this.setStatus(''); };
    emailField.createEl('small', { text: '仅在你愿意被回复时填写，会作为邮件回复地址。' });

    const diagnostics = form.createEl('details', { cls: 'pareno-feedback-diagnostics' });
    diagnostics.createEl('summary', { text: '将附带的环境信息（不含笔记内容）' });
    diagnostics.createEl('pre', { text: buildFeedbackDiagnostics(environment) });

    contentEl.createEl('p', {
      text: '反馈经站点的反馈接口发送到作者的私有 GitHub 收件库；只包含你填写的内容和上面的环境信息，不会自动发送。',
      cls: 'pareno-feedback-note'
    });

    const actions = contentEl.createDiv({ cls: 'pareno-feedback-actions' });
    const copyButton = actions.createEl('button', { text: '复制反馈内容' });
    copyButton.onclick = () => { void this.copy(environment); };
    const issueButton = actions.createEl('button', { text: '在 GitHub 提交 ↗' });
    issueButton.onclick = () => this.openIssue(environment);
    const submitButton = actions.createEl('button', {
      text: configured ? '提交反馈' : '提交反馈（未配置）',
      cls: 'mod-cta'
    });
    submitButton.disabled = !configured;
    submitButton.onclick = () => { void this.submit(environment); };

    const statusEl = contentEl.createEl('p', { cls: 'pareno-feedback-status', attr: { role: 'status', 'aria-live': 'polite' } });
    this.messageInput = message;
    this.counterEl = counter;
    this.statusEl = statusEl;
    this.submitButton = submitButton;
    message.focus();
  }

  onClose(): void { this.contentEl.empty(); }

  private setStatus(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = message;
    this.statusEl.className = `pareno-feedback-status${kind === 'info' ? '' : ` is-${kind}`}`;
  }

  private draft(): FeedbackDraft {
    return { category: this.category, message: this.message, email: this.email };
  }

  private async copy(environment: FeedbackEnvironment): Promise<void> {
    try {
      await navigator.clipboard.writeText(buildFeedbackCopyText(this.draft(), environment));
      new Notice('已复制反馈内容，尚未发送。');
    } catch {
      new Notice('无法访问剪贴板；请手动选择内容复制。');
    }
  }

  private openIssue(environment: FeedbackEnvironment): void {
    const description = this.message.trim()
      ? `[${feedbackCategoryLabel(this.category)}] ${this.message.trim()}`
      : `[${feedbackCategoryLabel(this.category)}] `;
    try {
      window.open(buildFeedbackIssueUrl(description, environment), '_blank');
      this.close();
    } catch {
      new Notice('无法打开浏览器；请使用「复制反馈内容」后手动提交。');
    }
  }

  private async submit(environment: FeedbackEnvironment): Promise<void> {
    if (this.sending) return;
    const draft = this.draft();
    const error = validateFeedbackDraft(draft);
    if (error) {
      this.setStatus(FEEDBACK_ERROR_TEXT[error], 'error');
      this.messageInput?.focus();
      return;
    }
    if (!isFeedbackDeliveryConfigured()) {
      this.setStatus('反馈提交尚未配置；请复制内容或使用 GitHub。', 'error');
      return;
    }
    this.sending = true;
    if (this.submitButton) { this.submitButton.disabled = true; this.submitButton.textContent = '正在发送…'; }
    this.setStatus('正在发送…');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const submission = buildFeedbackSubmission(draft, environment);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), 20000);
      });
      const response = await Promise.race([
        requestUrl({
          url: submission.url,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(submission.payload),
          throw: false
        }),
        timeout
      ]);
      const result = parseFeedbackDelivery(response.status, response.json);
      if (result.ok) {
        this.message = '';
        this.email = '';
        if (this.messageInput) this.messageInput.value = '';
        if (this.counterEl) this.counterEl.textContent = `0 / ${MAX_FEEDBACK_MESSAGE}`;
        const emailInput = this.contentEl.querySelector<HTMLInputElement>('input[type="email"]');
        if (emailInput) emailInput.value = '';
        this.setStatus('已收到反馈，谢谢！', 'success');
        new Notice('反馈已发送，谢谢！');
      } else if (result.reason === 'rate') {
        this.setStatus('提交过于频繁，请稍后再试；你填写的内容已保留。', 'error');
      } else if (result.reason === 'invalid') {
        this.setStatus('提交未通过校验，请检查内容；你填写的内容已保留。', 'error');
      } else {
        this.setStatus('发送失败，请稍后重试；你填写的内容已保留，也可复制或使用 GitHub。', 'error');
      }
    } catch {
      this.setStatus('发送失败或超时；你填写的内容已保留，可重试、复制或使用 GitHub。', 'error');
    } finally {
      if (timer) clearTimeout(timer);
      this.sending = false;
      if (this.submitButton) {
        this.submitButton.disabled = !isFeedbackDeliveryConfigured();
        this.submitButton.textContent = isFeedbackDeliveryConfigured() ? '提交反馈' : '提交反馈（未配置）';
      }
    }
  }
}

const FEEDBACK_ERROR_TEXT: Record<FeedbackValidationError, string> = {
  empty: '请先填写问题描述。',
  'too-long': `问题描述请控制在 ${MAX_FEEDBACK_MESSAGE} 字以内。`,
  'email-invalid': '请检查邮箱格式，或留空。'
};

class CoachSettingsTab extends PluginSettingTab {
  private readonly coach: ParenoPlugin;
  private ollamaSettingsRefresh = false;
  constructor(app: ParenoPlugin['app'], coach: ParenoPlugin) {
    super(app, coach);
    this.coach = coach;
  }
  private agentExecutableValue(kind: AgentKind): string {
    const settings = this.coach.settings;
    if (kind === 'codex') return settings.codexExecutable;
    if (kind === 'claude') return settings.claudeExecutable;
    if (kind === 'cursor-agent') return settings.cursorExecutable;
    return settings.opencodeExecutable;
  }

  private setAgentExecutableValue(kind: AgentKind, value: string): void {
    const settings = this.coach.settings;
    const trimmed = value.trim() || agentDefinition(kind).executable;
    if (kind === 'codex') settings.codexExecutable = trimmed;
    else if (kind === 'claude') settings.claudeExecutable = trimmed;
    else if (kind === 'cursor-agent') settings.cursorExecutable = trimmed;
    else settings.opencodeExecutable = trimmed;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'PARENO · 并言' });
    const statuses = this.coach.getAgentStatuses();
    if (statuses.some(status => status.state === 'unknown') && !this.coach.isAgentsChecking()) {
      void this.coach.ensureAgentStatuses().then(() => this.display());
    }
    new Setting(containerEl).setName('Provider / 模型来源')
      .setDesc('Ollama 可跑本机模型，也可用免费额度的云端模型；本机 Agent 使用已安装 CLI 的登录；兼容 API 走自定义端点。')
      .addDropdown(dropdown => {
        dropdown.addOption('ollama', 'Ollama · 本机 / 云端');
        for (const status of statuses) {
          const suffix = status.state === 'ready' ? ' · 可用' : status.state === 'unknown' ? ' · 检测中' : ' · 未检测到';
          dropdown.addOption(status.kind, `${status.label}${suffix}`);
        }
        dropdown.addOption('openai', 'OpenAI-compatible API');
        dropdown.setValue(this.coach.settings.provider);
        dropdown.onChange(async value => {
          const provider = value as Provider;
          const previous = this.coach.settings.provider;
          this.coach.settings.provider = provider;
          if (provider === 'ollama') {
            this.coach.settings.endpoint = 'http://localhost:11434/v1/chat/completions';
            this.coach.settings.ollamaCloud = false;
            this.coach.settings.model = 'qwen2.5:7b';
          } else if (provider === 'openai') {
            this.coach.settings.endpoint = 'https://api.openai.com/v1/chat/completions';
            this.coach.settings.model = 'gpt-4.1-mini';
          } else if (previous !== provider) {
            this.coach.settings.model = '';
          }
          await this.coach.saveSettings();
          this.display();
        });
      });

    const ollamaStatus = this.coach.getOllamaStatus();
    if (this.coach.settings.provider === 'ollama' && Date.now() - ollamaStatus.checkedAt > 10000 && !this.ollamaSettingsRefresh) {
      this.ollamaSettingsRefresh = true;
      void this.coach.ensureOllamaStatus(true).then(() => { this.ollamaSettingsRefresh = false; this.display(); });
    }
    if (this.coach.settings.provider === 'ollama') {
      const cloud = this.coach.settings.ollamaCloud;
      const connection = new Setting(containerEl)
        .setName('Ollama connection')
        .setDesc(ollamaStatusLabel(ollamaStatus, this.coach.settings.model, cloud));
      connection.addButton(button => button.setButtonText('检查连接').onClick(async () => {
        await this.coach.ensureOllamaStatus(true); this.display();
      }));
      if (ollamaStatus.state !== 'running') {
        connection.addButton(button => button.setButtonText(this.coach.isOllamaStarting() ? '正在启动…' : '启动 Ollama').setCta()
          .setDisabled(this.coach.isOllamaStarting())
          .onClick(async () => { await this.coach.startOllama(); this.display(); }));
      }
      if (ollamaStatus.state === 'missing') {
        connection.addButton(button => button.setButtonText('安装 Ollama').onClick(() => this.coach.openOllamaDownload()));
      }
      const localNames = [...new Set([...ollamaStatus.models, !cloud ? this.coach.settings.model : ''].filter(Boolean))];
      const cloudNames = [...new Set([...ollamaStatus.cloudModels, cloud ? this.coach.settings.model : ''].filter(Boolean))];
      const modelSetting = new Setting(containerEl)
        .setName('Ollama model')
        .setDesc(cloud ? '当前使用 Ollama 云端模型，需要 ollama.com API 密钥；免费额度按 Ollama 账户限制。' : '本机已安装模型直接运行；云端模型使用 Ollama Cloud 免费额度。');
      modelSetting.addDropdown(dropdown => {
        for (const name of localNames) dropdown.addOption(`local:${name}`, `本机 · ${name}`);
        for (const name of cloudNames) dropdown.addOption(`cloud:${name}`, `云端 · ${name}`);
        if (this.coach.settings.model) dropdown.setValue(`${cloud ? 'cloud' : 'local'}:${this.coach.settings.model}`);
        dropdown.onChange(async value => {
          if (!value) return;
          const separator = value.indexOf(':');
          const scope = value.slice(0, separator);
          const name = value.slice(separator + 1);
          if (!name) return;
          this.coach.settings.model = name;
          this.coach.settings.ollamaCloud = scope === 'cloud';
          await this.coach.saveSettings();
          this.display();
        });
      });
      modelSetting.addButton(button => button.setButtonText('刷新模型').onClick(async () => {
        await this.coach.refreshOllamaModel(); this.display();
      }));
      const keySetting = new Setting(containerEl)
        .setName('Ollama Cloud API key')
        .setDesc(cloud ? '云端模型需要 ollama.com 密钥（免费额度）；密钥只保存在本库插件设置。' : '可选：填入 ollama.com 密钥后使用云端模型。');
      keySetting.addText(text => {
        text.inputEl.type = 'password';
        text.setPlaceholder('ollama.com 密钥').setValue(this.coach.settings.ollamaApiKey)
          .onChange(async value => { this.coach.settings.ollamaApiKey = value.trim(); await this.coach.saveSettings(); });
      });
      keySetting.addButton(button => button.setButtonText('创建密钥').onClick(() => this.coach.openOllamaKeys()));
      if (!ollamaStatus.models.length && ollamaStatus.state === 'running') {
        containerEl.createEl('p', { text: '还没有安装本机模型。可在终端运行 ollama pull qwen2.5:7b，或直接选云端模型。', cls: 'setting-item-description' });
      }
    }

    new Setting(containerEl).setName('本机 Agent').setDesc(agentStatusSummary(statuses))
      .addButton(button => button.setButtonText(this.coach.isAgentsChecking() ? '正在检测…' : '重新检测')
        .setDisabled(this.coach.isAgentsChecking())
        .onClick(async () => { await this.coach.ensureAgentStatuses(true); this.display(); }));
    for (const status of statuses) {
      const definition = agentDefinition(status.kind);
      const suffix = status.state === 'ready' ? ` · ${status.version}` : status.state === 'unknown' ? ' · 检测中' : status.state === 'missing' ? ' · 未检测到' : ' · 不可用';
      const setting = new Setting(containerEl)
        .setName(`${definition.label}${suffix}`)
        .setDesc(status.state === 'error' && status.message ? status.message : definition.hint);
      setting.addText(text => text.setValue(this.agentExecutableValue(status.kind))
        .onChange(async value => { this.setAgentExecutableValue(status.kind, value); await this.coach.saveSettings(); }));
    }
    if (this.coach.settings.provider !== 'ollama' && this.coach.settings.provider !== 'openai') {
      new Setting(containerEl).setName('Agent model (optional)')
        .setDesc('留空使用该 Agent 的默认模型；也可填写它支持的名字，例如 sonnet、gpt-5。')
        .addText(text => text.setValue(this.coach.settings.model)
          .onChange(async value => { this.coach.settings.model = value.trim(); await this.coach.saveSettings(); }));
    }
    if (this.coach.settings.provider === 'openai') {
      new Setting(containerEl).setName('API endpoint').setDesc('Chat Completions-compatible URL.')
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
    }
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
    containerEl.createEl('h3', { text: '反馈与支持 · Feedback' });
    new Setting(containerEl)
      .setName('反馈问题 / Feedback')
      .setDesc('打开反馈窗口：填写后直接发送到作者（私有收件库），也可复制内容或去 GitHub。仅附带版本、平台、模型方式与名称、写作语体与自动审校状态，不含笔记内容或密钥。')
      .addButton(button => button.setButtonText('打开反馈窗口').setCta().onClick(() => { this.coach.openFeedback(); }))
      .addButton(button => button.setButtonText('复制环境信息').onClick(async () => { await this.coach.copyFeedbackDiagnostics(); }));
    containerEl.createEl('p', { text: 'Paragraph tasks send the selected text or current paragraph. Whole-article review sends the current note in batches after you click Start. The plugin never edits the article without your confirmation.', cls: 'setting-item-description' });
  }
}
