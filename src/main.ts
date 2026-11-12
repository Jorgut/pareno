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
import { Provider, requestWritingModel } from './provider';
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
  codexExecutable: string;
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
  codexExecutable: 'codex',
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

export default class ParenoPlugin extends Plugin {
  settings: CoachSettings = DEFAULT_SETTINGS;
  private inline = createInlineReview(() => { if (this.analysis) this.analysis.applied = true; this.documentIssues = []; this.renderPanel(); });
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

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.lastMarkdownView = this.findActiveMarkdownView();
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      if (leaf?.view instanceof MarkdownView) this.lastMarkdownView = leaf.view;
    }));
    this.registerView(PANEL_TYPE, leaf => new CoachSidebar(leaf, this));
    this.registerEditorExtension([
      ...this.inline.extension,
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
    return this.applyRevision(this.analysis?.result[kind] ?? '', insertBelow);
  }

  applyRevision(replacement: string, insertBelow = false): boolean {
    const analysis = this.analysis;
    if (!analysis) return false;
    const { editor, from, to, source } = analysis.context;
    if (analysis.applied || this.currentMarkdownView()?.file?.path !== analysis.context.filePath || editor.getRange(from, to) !== source) {
      new Notice('This text has changed. Run the check again before applying suggestions.');
      return false;
    }
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
    const analysis = this.coach.getAnalysis();
    const pending = this.coach.getPending();
    const context = this.coach.getCurrentContext();
    const current = body.createDiv({ cls: 'pareno-current' });
    current.createEl('strong', { text: '当前选区 / 段落' });
    current.createEl('span', { text: (context?.filePath ?? this.coach.getCurrentFilePath())?.split('/').pop() ?? '请打开文章' });
    current.createEl('p', { text: context?.source.slice(0, 220) || '在正文中选中文字，或把光标放在有文字的段落里。' });

    body.createEl('div', { text: '01 / 检查范围', cls: 'pareno-step' });
    const scopes = body.createDiv({ cls: 'pareno-scope' });
    for (const [scope, label] of [['paragraph', '选区 / 当前段落'], ['document', '整篇文章']] as const) {
      const button = scopes.createEl('button', { text: label });
      if (this.coach.getScope() === scope) button.addClass('is-active');
      button.onclick = () => this.coach.setScope(scope);
    }

    body.createEl('div', { text: '02 / 我想做什么', cls: 'pareno-step' });
    const tasks = body.createDiv({ cls: 'pareno-tasks' });
    for (const [mode, label, detail] of [
      ['review', '检查与润色', '错误 + 可选表达'],
      ['translate', '翻译', '忠实 / 自然两版'],
      ['compare', '核对中英', '原意与证据强度'],
      ['explain', '解释表达', '语法与复用句型'],
      ['voice', '作者风格', '保留个人声音']
    ] as Array<[CoachMode, string, string]>) {
      const button = tasks.createEl('button');
      button.createEl('strong', { text: label });
      button.createEl('small', { text: detail });
      if (this.selectedMode === mode) button.addClass('is-active');
      button.onclick = () => { this.selectedMode = mode; this.render(); };
    }

    const model = body.createDiv({ cls: 'pareno-model' });
    model.createEl('span', { text: '模型与数据范围' });
    const select = model.createEl('select', { attr: { 'aria-label': '模型供应方式' } });
    for (const [value, label] of [['ollama', '本地 · Ollama'], ['codex', '云端 · Codex 登录'], ['openai', '云端 · 兼容 API']] as const) {
      select.createEl('option', { text: label, value });
    }
    select.value = this.coach.settings.provider;
    select.onchange = () => {
      const provider = select.value as Provider;
      this.coach.settings.provider = provider;
      if (provider === 'ollama') { this.coach.settings.endpoint = 'http://localhost:11434/v1/chat/completions'; this.coach.settings.model = 'qwen2.5:7b'; }
      if (provider === 'openai' && this.coach.settings.endpoint.startsWith('http://localhost:')) {
        this.coach.settings.endpoint = 'https://api.openai.com/v1/chat/completions'; this.coach.settings.model = 'gpt-4.1-mini';
      }
      void this.coach.saveSettings().then(() => this.render());
    };
    const start = body.createEl('button', { text: pending.mode ? '正在审校…' : '开始审校', cls: 'pareno-start' });
    start.disabled = Boolean(pending.mode);
    start.onclick = () => {
      if (this.coach.getScope() === 'document') {
        if (this.selectedMode !== 'review') { new Notice('全文范围目前支持“检查与润色”；其他任务请先选中段落。'); return; }
        this.coach.reviewActiveDocument();
      } else if (context) void this.coach.analyze(this.selectedMode, context);
      else new Notice('请先打开文章并把光标放在段落中。');
    };
    const local = this.coach.settings.provider === 'ollama';
    const whole = this.coach.getScope() === 'document';
    body.createEl('p', { text: whole
      ? local ? '全文将分批发送至本机 Ollama；须主动点击开始。' : '全文将分批发送至所选云端模型；须主动点击开始。'
      : local ? '只发送选区或当前段落；内容留在本机 Ollama。' : '只发送选区或当前段落至所选云端模型。', cls: 'bwc-hint' });

    if (pending.mode) {
      body.createEl('p', { text: pending.error || '正在分析所选段落…', cls: 'bwc-status' });
      this.action(body, '停止本次审校', () => this.coach.stopReview());
    }
    if (pending.error && !pending.mode) body.createEl('p', { text: pending.error, cls: 'bwc-error' });
    const documentIssues = this.coach.getDocumentIssues();
    if (documentIssues.length) {
      body.createEl('h4', { text: `${documentIssues.length} 处建议 · 点击定位到正文` });
      for (const issue of documentIssues) {
        const button = body.createEl('button', { text: `${issue.kind === 'grammar' ? '明确错误' : '可选表达'} · ${issue.quote.slice(0, 90)}`, cls: 'pareno-result-item' });
        button.onclick = () => this.coach.openIssue(issue.id);
      }
    } else if (!pending.mode && this.coach.getScope() === 'document' && !analysis) {
      body.createEl('p', { text: '全文审校后，逐处建议会列在这里，并映射到正文。', cls: 'bwc-hint' });
    }
    if (analysis) {
      const { result, mode, applied } = analysis;
      if (mode !== 'explain' && mode !== 'compare') {
        for (const [label, value, insertBelow] of [
          [mode === 'translate' ? '忠实翻译' : '最小修改', result.minimal, mode === 'translate'],
          [mode === 'translate' ? '自然译法' : '自然表达', result.natural, mode === 'translate']
        ] as Array<[string, string, boolean]>) {
          const section = body.createDiv({ cls: 'bwc-section' });
          section.createEl('div', { text: label, cls: 'bwc-section-label' });
          const edited = section.createEl('textarea', { attr: { 'aria-label': `${label}修改稿` } });
          edited.value = value;
          this.action(section, insertBelow ? '在原文后插入' : '确认并替换原文', () => this.coach.applyRevision(edited.value, insertBelow), true, applied);
        }
      }
      if (result.explanation) this.section(body, '修改依据 / Explanation', result.explanation);
      for (const issue of result.issues) {
        const item = body.createDiv({ cls: 'bwc-issue-card' });
        item.createEl('span', { text: issue.type === 'grammar' ? '明确错误' : '可选表达', cls: `bwc-kind bwc-kind-${issue.type}` });
        item.createEl('div', { text: `${issue.source} → ${issue.replacement}`, cls: 'bwc-issue-change' });
        if (issue.reason) item.createEl('p', { text: issue.reason });
      }
      const actions = body.createDiv({ cls: 'bwc-actions' });
      this.action(actions, '保存学习卡片', () => { void this.coach.saveLearning(); });
      this.action(actions, '忽略建议', () => this.coach.dismiss());
    }
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
  constructor(app: ParenoPlugin['app'], coach: ParenoPlugin) {
    super(app, coach);
    this.coach = coach;
  }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'PARENO · 并言' });
    new Setting(containerEl).setName('Provider').setDesc('Ollama runs locally. Codex uses the desktop CLI login. API mode sends text to the configured endpoint.')
      .addDropdown(dropdown => dropdown.addOption('ollama', 'Ollama (local)').addOption('codex', 'Codex CLI login').addOption('openai', 'OpenAI-compatible API')
        .setValue(this.coach.settings.provider).onChange(async value => {
          const provider = value as Provider;
          this.coach.settings.provider = provider;
          if (provider !== 'codex') {
            this.coach.settings.endpoint = provider === 'ollama'
              ? 'http://localhost:11434/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
            this.coach.settings.model = provider === 'ollama' ? 'qwen2.5:7b' : 'gpt-4.1-mini';
          }
          await this.coach.saveSettings(); this.display();
        }));
    new Setting(containerEl).setName('Codex executable').setDesc('Only for Codex mode. Uses the CLI’s existing login; no token is copied into PARENO.')
      .addText(text => text.setValue(this.coach.settings.codexExecutable).onChange(async value => {
        this.coach.settings.codexExecutable = value.trim() || 'codex'; await this.coach.saveSettings();
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
    containerEl.createEl('h3', { text: '反馈与支持 · Feedback' });
    new Setting(containerEl)
      .setName('反馈问题 / Feedback')
      .setDesc('打开反馈窗口：填写后直接发送到作者（私有收件库），也可复制内容或去 GitHub。仅附带版本、平台、模型方式与名称、写作语体与自动审校状态，不含笔记内容或密钥。')
      .addButton(button => button.setButtonText('打开反馈窗口').setCta().onClick(() => { this.coach.openFeedback(); }))
      .addButton(button => button.setButtonText('复制环境信息').onClick(async () => { await this.coach.copyFeedbackDiagnostics(); }));
    containerEl.createEl('p', { text: 'Paragraph tasks send the selected text or current paragraph. Whole-article review sends the current note in batches after you click Start. The plugin never edits the article without your confirmation.', cls: 'setting-item-description' });
  }
}
