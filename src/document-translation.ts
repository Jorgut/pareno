export type TranslationVariant = 'faithful' | 'natural';

export interface TranslationSegment {
  from: number;
  to: number;
  heading?: boolean;
  faithful: string;
  natural: string;
}

export function translationText(segment: TranslationSegment, variant: TranslationVariant): string {
  return (variant === 'natural' ? segment.natural : segment.faithful).trim();
}

export function orderedSegments(segments: TranslationSegment[]): TranslationSegment[] {
  return [...segments].sort((left, right) => left.from - right.from);
}

export function canInsertAfter(source: string, segment: TranslationSegment): boolean {
  if (segment.to >= source.length) return true;
  return source[segment.to] === '\n';
}

export function insertTranslations(source: string, segments: TranslationSegment[], variant: TranslationVariant): string {
  let output = '';
  let cursor = 0;
  for (const segment of orderedSegments(segments)) {
    if (segment.from < cursor) continue;
    const text = translationText(segment, variant);
    output += source.slice(cursor, segment.to);
    if (text) output += `\n\n${text}`;
    cursor = segment.to;
  }
  output += source.slice(cursor);
  return output;
}

export function appendixTranslation(segments: TranslationSegment[], variant: TranslationVariant, heading = '## 译文'): string {
  const texts = orderedSegments(segments).map(segment => translationText(segment, variant)).filter(Boolean);
  if (!texts.length) return '';
  return `${heading}\n\n${texts.join('\n\n')}`;
}

export function translationNote(title: string, segments: TranslationSegment[], variant: TranslationVariant): string {
  const texts = orderedSegments(segments).map(segment => translationText(segment, variant)).filter(Boolean);
  return `# ${title}\n\n${texts.join('\n\n')}\n`;
}

export function translationNoteTitle(fileName: string): string {
  return `${fileName.replace(/\.md$/i, '')} · 译文`;
}
