export type CoachMode = 'review' | 'translate' | 'explain';
export type IssueKind = 'grammar' | 'style' | 'wording';

export interface CoachIssue {
  source: string;
  replacement: string;
  type: IssueKind;
  reason: string;
}

export interface CoachResult {
  minimal: string;
  natural: string;
  explanation: string;
  issues: CoachIssue[];
  learning: {
    title: string;
    rule: string;
    example: string;
  };
}

const MAX_INPUT = 3500;

export function validateSelection(value: string): string {
  if (!value.trim()) throw new Error('Please select a word, sentence, or paragraph.');
  if (value.length > MAX_INPUT) throw new Error(`Please select ${MAX_INPUT} characters or fewer.`);
  return value;
}

export function buildMessages(mode: CoachMode, source: string, register: string): Array<{ role: string; content: string }> {
  const direction = /[\u3400-\u9fff]/u.test(source) ? 'Chinese to English' : 'English to Chinese';
  const task = mode === 'translate'
    ? `Translate ${direction}. The minimal field is a faithful translation. The natural field is fluent ${direction.endsWith('English') ? 'English' : 'Chinese'} in a ${register} register. Explain one or two important choices in Simplified Chinese. Do not invent facts.`
    : mode === 'review'
      ? `Proofread the selected writing in a ${register} register. Minimal must correct only genuine mistakes. Natural may improve expression without changing meaning. Include precise issue spans copied verbatim from the source, their replacements, and concise Chinese explanations. Do not classify valid variants as grammar errors. Preserve names, numbers, quotations, and citations.`
      : `Explain the selected text in Simplified Chinese, including grammar, structure, vocabulary, and one reusable example. Keep minimal and natural equal to the source unless an actual error requires a correction.`;

  const instruction = `You are a bilingual writing coach for a designer working in architecture, HCI, product design, and podcasts. ${task}\n` +
    'Respond with only one JSON object, no Markdown. Schema: ' +
    '{"minimal":"string","natural":"string","explanation":"Simplified Chinese explanation",' +
    '"issues":[{"source":"exact substring of input","replacement":"replacement text","type":"grammar|style|wording","reason":"Simplified Chinese"}],' +
    '"learning":{"title":"short topic","rule":"Simplified Chinese","example":"one correct English example"}}. ' +
    'If no issues exist, return issues as []. If the task is translation, issues should usually be []. ' +
    'Be specific and concise, preserving the author’s intent and tone.';

  return [
    { role: 'system', content: instruction },
    { role: 'user', content: `Selected text:\n${source}` }
  ];
}

function readTextContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((item): item is { text: string } =>
    Boolean(item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'))
    .map(item => item.text).join('');
  return '';
}

export function parseCoachResponse(payload: unknown, original: string): CoachResult {
  if (!payload || typeof payload !== 'object') throw new Error('The provider returned an empty response.');
  const object = payload as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = readTextContent(object.choices?.[0]?.message?.content);
  if (!content.trim()) throw new Error('The provider did not return any writing suggestions.');

  let data: unknown;
  try {
    const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    data = JSON.parse(cleaned);
  } catch {
    throw new Error('The provider returned an unexpected format. Try again or select another model.');
  }
  if (!data || typeof data !== 'object') throw new Error('The provider returned an invalid result.');
  const result = data as Record<string, unknown>;
  const stringOr = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
  const issues: CoachIssue[] = Array.isArray(result.issues) ? result.issues.slice(0, 20).flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const issue = value as Record<string, unknown>;
    if (typeof issue.source !== 'string' || !issue.source || typeof issue.replacement !== 'string') return [];
    return [{
      source: issue.source,
      replacement: issue.replacement,
      type: issue.type === 'grammar' || issue.type === 'style' ? issue.type : 'wording',
      reason: stringOr(issue.reason)
    }];
  }) : [];
  const learning = result.learning && typeof result.learning === 'object'
    ? result.learning as Record<string, unknown> : {};

  return {
    minimal: stringOr(result.minimal, original),
    natural: stringOr(result.natural, original),
    explanation: stringOr(result.explanation),
    issues,
    learning: {
      title: stringOr(learning.title, 'Writing note'),
      rule: stringOr(learning.rule),
      example: stringOr(learning.example)
    }
  };
}

export function findIssueRanges(source: string, issues: CoachIssue[]): Array<{ from: number; to: number; kind: IssueKind }> {
  const ranges: Array<{ from: number; to: number; kind: IssueKind }> = [];
  for (const issue of issues) {
    let from = source.indexOf(issue.source);
    while (from !== -1 && ranges.some(range => from < range.to && from + issue.source.length > range.from)) {
      from = source.indexOf(issue.source, from + 1);
    }
    if (from !== -1) ranges.push({ from, to: from + issue.source.length, kind: issue.type });
  }
  return ranges.sort((a, b) => a.from - b.from);
}

export function makeLearningMarkdown(source: string, result: CoachResult, mode: CoachMode, timestamp = new Date()): string {
  const quote = (value: string) => value.split('\n').map(line => `> ${line}`).join('\n');
  const date = timestamp.toISOString().slice(0, 10);
  return [
    `## ${date} · ${result.learning.title.replace(/[\r\n]/g, ' ')}`,
    `**Action:** ${mode}`,
    '', '**Original**', quote(source),
    '', '**Minimal correction / faithful translation**', quote(result.minimal),
    '', '**Natural alternative**', quote(result.natural),
    '', '**Explanation**', result.explanation || 'No explanation provided.',
    '', '**Reusable rule**', result.learning.rule || 'No rule provided.',
    '', '**Example**', result.learning.example || 'No example provided.',
    '', '---', ''
  ].join('\n');
}
