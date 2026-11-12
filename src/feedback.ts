export const FEEDBACK_REPO_URL = 'https://github.com/Jorgut/pareno';
export const FEEDBACK_ISSUES_URL = `${FEEDBACK_REPO_URL}/issues/new`;
export const FEEDBACK_MAX_URL_LENGTH = 7000;

// Set this after deploying the website: https://<project>.pages.dev/api/feedback
// See docs/DEPLOY-CLOUDFLARE.md.
export const FEEDBACK_SUBMIT_ENDPOINT = 'https://parenowriter.pages.dev/api/feedback';
export const MAX_FEEDBACK_MESSAGE = 2000;

export interface FeedbackEnvironment {
  pluginVersion: string;
  obsidianVersion: string;
  platform: string;
  provider: string;
  model: string;
  register: string;
  autoReview: boolean;
}

export interface PlatformFlags {
  isIosApp?: boolean;
  isAndroidApp?: boolean;
  isMacOS?: boolean;
  isWin?: boolean;
  isLinux?: boolean;
  isMobile?: boolean;
}

const PROVIDER_LABELS: Record<string, string> = {
  ollama: 'Ollama（本地）',
  codex: 'Codex CLI 登录',
  openai: '兼容 API'
};

export const ISSUE_TITLE_MAX = 60;

function replaceLoneSurrogates(value: string): string {
  return value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD'
  );
}

function cleanLine(value: unknown, maxLength: number): string {
  const characters = [...replaceLoneSurrogates(String(value ?? '')).replace(/[\r\n\t]+/g, ' ').trim()];
  return characters.slice(0, maxLength).join('');
}

export function describePlatform(flags: PlatformFlags): string {
  // Obsidian reports isMacOS on iOS devices as well, so check the mobile apps first.
  const system = flags.isIosApp ? 'iOS'
    : flags.isAndroidApp ? 'Android'
      : flags.isMacOS ? 'macOS'
        : flags.isWin ? 'Windows'
          : flags.isLinux ? 'Linux'
            : '未知系统';
  return `${system} · ${flags.isMobile ? '移动版' : '桌面版'}`;
}

export function sanitizeFeedbackDescription(input: unknown, maxLength = 3000): string {
  if (typeof input !== 'string') return '';
  const normalized = replaceLoneSurrogates(input)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const trimmed = normalized.trim();
  const characters = [...trimmed];
  return characters.length > maxLength ? characters.slice(0, maxLength).join('') : trimmed;
}

/**
 * Only whitelisted environment fields may reach the issue body. Never add note
 * text, vault paths, endpoints or API keys here: everything in this output is
 * shown to the user and may be published on GitHub.
 */
export function buildFeedbackDiagnostics(environment: FeedbackEnvironment): string {
  const provider = cleanLine(environment.provider, 30);
  const lines = [
    `PARENO: ${cleanLine(environment.pluginVersion, 20) || '未知'}`,
    `Obsidian API: ${cleanLine(environment.obsidianVersion, 20) || '未知'}`,
    `平台: ${cleanLine(environment.platform, 60) || '未知'}`,
    `模型方式: ${PROVIDER_LABELS[provider] ?? (provider || '未知')}`,
    `写作语体: ${cleanLine(environment.register, 30) || 'professional'}`,
    `自动段落审校: ${environment.autoReview ? '开启' : '关闭'}`
  ];
  // Codex mode ignores the model setting, so showing it would only be misleading.
  if (provider !== 'codex') lines.splice(4, 0, `模型: ${cleanLine(environment.model, 80) || '默认'}`);
  return lines.join('\n');
}

export function feedbackIssueTitle(description: string): string {
  const firstLine = sanitizeFeedbackDescription(description, 3000)
    .split('\n').map(line => line.trim()).find(Boolean) ?? '';
  const cleaned = firstLine.replace(/\s+/g, ' ');
  const characters = [...cleaned];
  const base = characters.slice(0, ISSUE_TITLE_MAX).join('') || 'PARENO 问题';
  const truncated = characters.length > ISSUE_TITLE_MAX;
  return `[反馈] ${base}${truncated ? '…' : ''}`;
}

export function buildFeedbackIssueBody(description: string, diagnostics: string): string {
  const text = sanitizeFeedbackDescription(description, 3000);
  return [
    '### 问题描述',
    '',
    text || '_请说明遇到的问题、复现步骤和期望结果。_',
    '',
    '### 环境信息',
    '',
    diagnostics
  ].join('\n');
}

export function buildFeedbackIssueUrl(description: string, environment: FeedbackEnvironment): string {
  const diagnostics = buildFeedbackDiagnostics(environment);
  const full = sanitizeFeedbackDescription(description, 3000);
  const title = feedbackIssueTitle(full);
  const compose = (text: string): string => {
    const body = buildFeedbackIssueBody(text, diagnostics);
    return `${FEEDBACK_ISSUES_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  };
  const fullUrl = compose(full);
  if (fullUrl.length <= FEEDBACK_MAX_URL_LENGTH) return fullUrl;

  // Long descriptions (especially Chinese, which expands ~9x when encoded)
  // would make the prefilled URL unusable. Trim the description, not the diagnostics.
  const characters = [...full];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${characters.slice(0, middle).join('')}…`;
    if (compose(candidate).length <= FEEDBACK_MAX_URL_LENGTH) low = middle;
    else high = middle - 1;
  }
  return compose(`${characters.slice(0, low).join('')}…`);
}

/** Plain-text version for "copy and paste" users without a GitHub account. */
export function buildFeedbackReport(description: string, environment: FeedbackEnvironment): string {
  return [
    'PARENO 反馈 / Feedback',
    '',
    '问题描述：',
    sanitizeFeedbackDescription(description, 6000) || '（未填写）',
    '',
    buildFeedbackDiagnostics(environment),
    '',
    `提交地址：${FEEDBACK_ISSUES_URL}`
  ].join('\n');
}

export type FeedbackCategory = 'bug' | 'suggestion' | 'quality' | 'other';

export const FEEDBACK_CATEGORIES: Array<{ value: FeedbackCategory; label: string }> = [
  { value: 'bug', label: '问题 / Bug' },
  { value: 'suggestion', label: '功能建议' },
  { value: 'quality', label: '翻译或建议质量' },
  { value: 'other', label: '其他' }
];

export interface FeedbackDraft {
  category: FeedbackCategory;
  message: string;
  email: string;
}

export type FeedbackValidationError = 'empty' | 'too-long' | 'email-invalid';

const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>.]+(?:\.[^\s@<>.]+)+$/;

export function feedbackCategoryLabel(category: FeedbackCategory): string {
  return FEEDBACK_CATEGORIES.find(item => item.value === category)?.label ?? '其他';
}

export function validateFeedbackDraft(draft: FeedbackDraft): FeedbackValidationError | null {
  const message = draft.message.trim();
  if (!message) return 'empty';
  if ([...message].length > MAX_FEEDBACK_MESSAGE) return 'too-long';
  const email = draft.email.trim();
  if (email && ([...email].length > 254 || !EMAIL_PATTERN.test(email))) return 'email-invalid';
  return null;
}

export function isFeedbackDeliveryConfigured(endpoint: string = FEEDBACK_SUBMIT_ENDPOINT): boolean {
  return endpoint.trim().length > 0;
}

export interface FeedbackSubmission {
  url: string;
  payload: {
    email?: string;
    message: string;
    category: string;
    environment: string;
    _subject: string;
    _gotcha: string;
  };
}

/**
 * Payload for the PARENO feedback endpoint (Cloudflare Pages Function). The
 * `_subject` / `_gotcha` fields stay for compatibility with generic form
 * endpoints. Only user input plus whitelisted diagnostics are included.
 */
export function buildFeedbackSubmission(draft: FeedbackDraft, environment: FeedbackEnvironment,
  endpoint: string = FEEDBACK_SUBMIT_ENDPOINT): FeedbackSubmission {
  const url = endpoint.trim();
  if (!url) throw new Error('Feedback endpoint is not configured.');
  const email = draft.email.trim();
  const category = feedbackCategoryLabel(draft.category);
  const submission: FeedbackSubmission = {
    url,
    payload: {
      message: draft.message.trim(),
      category,
      environment: buildFeedbackDiagnostics(environment),
      _subject: `[PARENO] 反馈 · ${category}`,
      _gotcha: ''
    }
  };
  if (email) submission.payload.email = email;
  return submission;
}

export type FeedbackDeliveryFailure = 'rate' | 'invalid' | 'unavailable';
export type FeedbackDeliveryResult = { ok: true } | { ok: false; reason: FeedbackDeliveryFailure };

export function parseFeedbackDelivery(status: number, payload: unknown): FeedbackDeliveryResult {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const delivered = record.ok === true || record.success === true;
  if (status >= 200 && status < 300 && delivered) return { ok: true };
  if (status === 429) return { ok: false, reason: 'rate' };
  if (status >= 400 && status < 500) return { ok: false, reason: 'invalid' };
  return { ok: false, reason: 'unavailable' };
}

/** Plain-text version for the copy fallback, matching what the submission carries. */
export function buildFeedbackCopyText(draft: FeedbackDraft, environment: FeedbackEnvironment): string {
  const lines = [
    'PARENO 反馈 / Feedback',
    '',
    `类型：${feedbackCategoryLabel(draft.category)}`,
    '',
    '问题描述：',
    sanitizeFeedbackDescription(draft.message, MAX_FEEDBACK_MESSAGE) || '（未填写）',
    ''
  ];
  const email = draft.email.trim();
  if (email) lines.push(`联系邮箱：${email}`, '');
  lines.push(buildFeedbackDiagnostics(environment));
  return lines.join('\n');
}
