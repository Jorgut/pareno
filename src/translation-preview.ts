import { Editor, editorInfoField } from 'obsidian';
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';

export type TranslationVariant = 'faithful' | 'natural';

interface TranslationPreviewData {
  from: number;
  to: number;
  faithful: string;
  natural: string;
  variant: TranslationVariant;
  onApply: (text: string, insertBelow: boolean) => void;
}

interface PreviewState { data: TranslationPreviewData | null }

const showPreview = StateEffect.define<TranslationPreviewData | null>();

class TranslationWidget extends WidgetType {
  constructor(private readonly data: TranslationPreviewData) { super(); }

  eq(other: TranslationWidget): boolean { return other.data === this.data; }

  toDOM(view: EditorView): HTMLElement {
    const root = view.dom.ownerDocument.createElement('div');
    root.className = 'pareno-translation-preview';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'PARENO 译文预览');

    const head = root.createDiv({ cls: 'pareno-translation-head' });
    head.createEl('span', { text: '译文预览', cls: 'pareno-translation-title' });

    let activeVariant: TranslationVariant = this.data.variant;
    const texts: Record<TranslationVariant, HTMLElement> = {
      faithful: root.createEl('p', { text: this.data.faithful, cls: 'pareno-translation-text' }),
      natural: root.createEl('p', { text: this.data.natural, cls: 'pareno-translation-text' })
    };
    const buttons: Partial<Record<TranslationVariant, HTMLButtonElement>> = {};
    const syncVariant = () => {
      for (const variant of ['faithful', 'natural'] as const) {
        texts[variant].style.display = variant === activeVariant ? '' : 'none';
        buttons[variant]?.classList.toggle('is-active', variant === activeVariant);
        buttons[variant]?.setAttribute('aria-pressed', String(variant === activeVariant));
      }
    };
    for (const [variant, label] of [['faithful', '忠实'], ['natural', '自然']] as const) {
      const button = head.createEl('button', { text: label, attr: { type: 'button' } });
      buttons[variant] = button;
      button.onclick = () => { activeVariant = variant; syncVariant(); };
    }
    const close = head.createEl('button', { text: '关闭', attr: { type: 'button', 'aria-label': '关闭译文预览' } });
    close.onclick = () => view.dispatch({ effects: showPreview.of(null) });
    syncVariant();

    const actions = root.createDiv({ cls: 'pareno-translation-actions' });
    const replace = actions.createEl('button', { text: '替换原文', cls: 'mod-warning', attr: { type: 'button' } });
    replace.onclick = () => {
      const text = this.data[activeVariant];
      view.dispatch({ effects: showPreview.of(null) });
      this.data.onApply(text, false);
    };
    const insert = actions.createEl('button', { text: '在原文后插入', cls: 'mod-cta', attr: { type: 'button' } });
    insert.onclick = () => {
      const text = this.data[activeVariant];
      view.dispatch({ effects: showPreview.of(null) });
      this.data.onApply(text, true);
    };
    return root;
  }
}

const field = StateField.define<PreviewState>({
  create: () => ({ data: null }),
  update(value, transaction) {
    if (transaction.docChanged) return { data: null };
    for (const effect of transaction.effects) {
      if (effect.is(showPreview)) return { data: effect.value };
    }
    return value;
  },
  provide: state => [
    EditorView.decorations.from(state, value => {
      if (!value.data) return Decoration.none;
      return Decoration.set([
        Decoration.widget({ widget: new TranslationWidget(value.data), side: 1, block: true }).range(value.data.to)
      ]);
    })
  ]
});

export function createTranslationPreview() {
  const views = new Set<EditorView>();
  const registry = ViewPlugin.fromClass(class {
    constructor(readonly view: EditorView) { views.add(view); }
    destroy() { views.delete(this.view); }
  });
  const matchingViews = (editor: Editor): EditorView[] =>
    [...views].filter(view => view.state.field(editorInfoField, false)?.editor === editor);

  return {
    extension: [field, registry],
    show(editor: Editor, documentText: string, data: Omit<TranslationPreviewData, 'variant' | 'onApply'>, onApply: (text: string, insertBelow: boolean) => void): void {
      for (const view of matchingViews(editor)) {
        if (view.state.doc.toString() !== documentText) continue;
        view.dispatch({ effects: showPreview.of({ ...data, variant: 'faithful', onApply }) });
      }
    },
    clear(editor?: Editor): void {
      for (const view of editor ? matchingViews(editor) : [...views]) {
        view.dispatch({ effects: showPreview.of(null) });
      }
    }
  };
}
