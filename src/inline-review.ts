import { Editor, editorInfoField } from 'obsidian';
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, hoverTooltip, showTooltip, ViewPlugin } from '@codemirror/view';
import { InlineIssue, IssueKind } from './core';

interface ReviewState { issues: InlineIssue[]; active: string | null }
const setIssues = StateEffect.define<InlineIssue[]>();
const openIssue = StateEffect.define<string | null>();
const dismissIssue = StateEffect.define<string>();
const labels: Record<IssueKind, string> = { grammar: '明确错误', style: '表达建议 · 可选', wording: '用词建议 · 可选' };

export function createInlineReview(onApplied: (issue: InlineIssue, replacement: string) => void) {
  const views = new Set<EditorView>();
  const field = StateField.define<ReviewState>({
    create: () => ({ issues: [], active: null }),
    update(value, transaction) {
      if (transaction.docChanged) return { issues: [], active: null };
      for (const effect of transaction.effects) {
        if (effect.is(setIssues)) value = { issues: effect.value, active: null };
        if (effect.is(openIssue)) value = { ...value, active: effect.value };
        if (effect.is(dismissIssue)) value = { issues: value.issues.filter(issue => issue.id !== effect.value), active: null };
      }
      return value;
    },
    provide: stateField => [
      EditorView.decorations.from(stateField, value => Decoration.set(value.issues.map(issue => Decoration.mark({
        class: `pareno-inline-mark pareno-inline-${issue.kind}${issue.scope === 'document' ? ' pareno-inline-box' : ''}`,
        attributes: { 'data-pareno-issue': issue.id, 'aria-label': `${labels[issue.kind]}：${issue.reason}`, role: 'button', tabindex: '0' }
      }).range(issue.from, issue.to)), true)),
      showTooltip.from(stateField, value => {
        const active = value.issues.find(issue => issue.id === value.active);
        return active ? makeTooltip(active) : null;
      })
    ]
  });

  function makeTooltip(issue: InlineIssue) {
    return { pos: issue.from, end: issue.to, above: true, arrow: true, create(view: EditorView) {
      const snapshot = view.state.doc;
      const doc = view.dom.ownerDocument;
      const dom = doc.createElement('div');
      dom.className = 'pareno-inline-tooltip';
      dom.setAttribute('role', 'dialog');
      dom.setAttribute('aria-label', 'PARENO 写作建议');
      const header = dom.createEl('div', { cls: 'pareno-tooltip-head' });
      header.createEl('strong', { text: labels[issue.kind] });
      const close = header.createEl('button', { text: '关闭', attr: { 'aria-label': '关闭建议' } });
      close.onclick = () => view.dispatch({ effects: openIssue.of(null) });
      dom.createEl('p', { text: issue.reason || '请结合上下文判断是否采用。' });
      dom.createEl('blockquote', { text: issue.quote });
      for (const option of issue.options) {
        const card = dom.createDiv({ cls: 'pareno-tooltip-option' });
        card.createEl('span', { text: option.label, cls: 'pareno-tooltip-label' });
        const edited = card.createEl('textarea', { attr: { 'aria-label': `${option.label}建议稿` } });
        edited.value = option.replacement;
        edited.rows = Math.min(7, Math.max(2, option.replacement.split('\n').length));
        const apply = card.createEl('button', { text: '确认并替换原文', cls: 'mod-cta' });
        apply.onclick = () => {
          if (view.state.doc !== snapshot || view.state.doc.sliceString(option.from, option.to) !== option.quote) return;
          const replacement = edited.value;
          view.dispatch({ changes: { from: option.from, to: option.to, insert: replacement },
            selection: { anchor: option.from + replacement.length }, userEvent: 'input.pareno-review' });
          view.focus();
          onApplied(issue, replacement);
        };
      }
      if (!issue.options.length) dom.createEl('p', { text: '这是一条阅读提示，没有可直接替换的修改稿。' });
      const ignore = dom.createEl('button', { text: '忽略这条' });
      ignore.onclick = () => view.dispatch({ effects: dismissIssue.of(issue.id) });
      return { dom };
    } };
  }

  const registry = ViewPlugin.fromClass(class {
    constructor(readonly view: EditorView) { views.add(view); }
    destroy() { views.delete(this.view); }
  });
  const hover = hoverTooltip((view, pos) => {
    const state = view.state.field(field);
    if (state.active !== null) return null;
    const issue = state.issues.find(item => pos >= item.from && pos < item.to);
    if (!issue) return null;
    return { pos: issue.from, end: issue.to, above: true, create() {
      const dom = view.dom.ownerDocument.createElement('div');
      dom.className = 'pareno-inline-hover';
      dom.textContent = `${labels[issue.kind]} · ${issue.reason || '点击查看并编辑建议'}`;
      return { dom };
    } };
  }, { hoverTime: 350 });
  const handlers = EditorView.domEventHandlers({
    mousedown(event, view) {
      const id = (event.target as Element | null)?.closest?.('[data-pareno-issue]')?.getAttribute('data-pareno-issue');
      if (id && event.button === 0) { event.preventDefault(); view.dispatch({ effects: openIssue.of(id) }); return true; }
      return false;
    },
    keydown(event, view) {
      const id = (event.target as Element | null)?.closest?.('[data-pareno-issue]')?.getAttribute('data-pareno-issue');
      if (id && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); view.dispatch({ effects: openIssue.of(id) }); return true; }
      if (event.key === 'Escape') view.dispatch({ effects: openIssue.of(null) });
      return false;
    }
  });
  function matchingViews(editor: Editor): EditorView[] {
    return [...views].filter(view => view.state.field(editorInfoField, false)?.editor === editor);
  }
  return {
    extension: [field, registry, hover, handlers],
    set(editor: Editor, documentText: string, issues: InlineIssue[]): number {
      let count = 0;
      for (const view of matchingViews(editor)) {
        if (view.state.doc.toString() !== documentText) continue;
        view.dispatch({ effects: setIssues.of(issues) }); count++;
      }
      return count;
    },
    open(editor: Editor, id: string): boolean {
      for (const view of matchingViews(editor)) {
        const issue = view.state.field(field).issues.find(item => item.id === id);
        if (!issue) continue;
        view.dispatch({ effects: [openIssue.of(id), EditorView.scrollIntoView(issue.from, { y: 'center' })] });
        return true;
      }
      return false;
    },
    clear(editor: Editor) { for (const view of matchingViews(editor)) view.dispatch({ effects: setIssues.of([]) }); },
    getIssues(editor: Editor): InlineIssue[] { return matchingViews(editor)[0]?.state.field(field).issues ?? []; }
  };
}
