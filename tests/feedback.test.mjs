import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFeedbackCopyText, buildFeedbackDiagnostics, buildFeedbackIssueBody, buildFeedbackIssueUrl,
  buildFeedbackReport, buildFeedbackSubmission, describePlatform, FEEDBACK_CATEGORIES, FEEDBACK_ISSUES_URL,
  FEEDBACK_MAX_URL_LENGTH, feedbackCategoryLabel, feedbackIssueTitle, isFeedbackDeliveryConfigured,
  ISSUE_TITLE_MAX, MAX_FEEDBACK_MESSAGE, parseFeedbackDelivery, sanitizeFeedbackDescription,
  validateFeedbackDraft, FEEDBACK_SUBMIT_ENDPOINT
} from '../src/feedback.ts';

const environment = {
  pluginVersion: '0.4.0',
  obsidianVersion: '1.8.7',
  platform: 'macOS · 桌面版',
  provider: 'ollama',
  model: 'qwen2.5:7b',
  register: 'professional',
  autoReview: false
};

test('diagnostics include only whitelisted environment fields', () => {
  const diagnostics = buildFeedbackDiagnostics({
    ...environment,
    apiKey: 'sk-should-never-appear',
    pangramApiKey: 'pangram-should-never-appear',
    endpoint: 'http://192.168.1.50:11434/v1/chat/completions',
    filePath: 'Private/未发表文章.md'
  });
  assert.match(diagnostics, /PARENO: 0\.4\.0/);
  assert.match(diagnostics, /Obsidian API: 1\.8\.7/);
  assert.match(diagnostics, /平台: macOS · 桌面版/);
  assert.match(diagnostics, /模型方式: Ollama（本地）/);
  assert.match(diagnostics, /自动段落审校: 关闭/);
  assert.doesNotMatch(diagnostics, /sk-should-never-appear|pangram-should-never-appear|192\.168|未发表文章/);
});

test('diagnostics translate provider modes and auto review state', () => {
  assert.match(buildFeedbackDiagnostics({ ...environment, provider: 'openai' }), /模型方式: 兼容 API/);
  assert.match(buildFeedbackDiagnostics({ ...environment, provider: 'codex' }), /模型方式: Codex CLI 登录/);
  assert.doesNotMatch(buildFeedbackDiagnostics({ ...environment, provider: 'codex' }), /^模型:/m);
  assert.match(buildFeedbackDiagnostics({ ...environment, autoReview: true }), /自动段落审校: 开启/);
});

test('platform description checks mobile apps before macOS', () => {
  assert.equal(describePlatform({ isIosApp: true, isMacOS: true, isMobile: true }), 'iOS · 移动版');
  assert.equal(describePlatform({ isAndroidApp: true, isMobile: true }), 'Android · 移动版');
  assert.equal(describePlatform({ isMacOS: true }), 'macOS · 桌面版');
  assert.equal(describePlatform({ isWin: true }), 'Windows · 桌面版');
  assert.equal(describePlatform({ isLinux: true }), 'Linux · 桌面版');
  assert.equal(describePlatform({}), '未知系统 · 桌面版');
});

test('description sanitization trims, normalizes and strips control characters', () => {
  assert.equal(sanitizeFeedbackDescription('  \r\n第一行\r\n第二行\u0000\u0007  '), '第一行\n第二行');
  assert.equal(sanitizeFeedbackDescription('abcdef', 3), 'abc');
  assert.equal(sanitizeFeedbackDescription('中文反馈文本', 3), '中文反');
  assert.equal(sanitizeFeedbackDescription(undefined), '');
});

test('issue title uses the first meaningful line and stays short', () => {
  assert.equal(feedbackIssueTitle(''), '[反馈] PARENO 问题');
  assert.equal(feedbackIssueTitle('\n\n  全文审校第 3 段失败  \n更多细节'), '[反馈] 全文审校第 3 段失败');
  assert.equal(feedbackIssueTitle('\u0000\n\n真实问题标题'), '[反馈] 真实问题标题');
  const long = '很长的反馈标题'.repeat(20);
  const title = feedbackIssueTitle(long);
  assert.ok(title.startsWith('[反馈] '));
  assert.ok(title.endsWith('…'));
  assert.ok([...title].length <= ISSUE_TITLE_MAX + 6, `title had ${[...title].length} characters`);
  assert.doesNotMatch(title, /\n/);
});

test('issue body keeps the user text and appends diagnostics', () => {
  const diagnostics = buildFeedbackDiagnostics(environment);
  const body = buildFeedbackIssueBody('翻译结果没有返回。', diagnostics);
  assert.match(body, /### 问题描述/);
  assert.match(body, /翻译结果没有返回。/);
  assert.match(body, /### 环境信息/);
  assert.match(body, /PARENO: 0\.4\.0/);
  assert.match(buildFeedbackIssueBody('', diagnostics), /请说明遇到的问题/);
});

test('issue url prefills title and body without leaking secrets', () => {
  const url = buildFeedbackIssueUrl('侧栏点开始审校后没有反应', {
    ...environment,
    apiKey: 'sk-secret',
    endpoint: 'http://internal.example/v1'
  });
  assert.ok(url.startsWith(`${FEEDBACK_ISSUES_URL}?title=`));
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('title'), '[反馈] 侧栏点开始审校后没有反应');
  const body = parsed.searchParams.get('body') ?? '';
  assert.match(body, /侧栏点开始审校后没有反应/);
  assert.match(body, /PARENO: 0\.4\.0/);
  assert.doesNotMatch(body, /sk-secret|internal\.example/);
  assert.doesNotMatch(url, / /);
});

test('very long descriptions are truncated so the issue url stays usable', () => {
  const description = '这一段描述非常长。'.repeat(500);
  const url = buildFeedbackIssueUrl(description, environment);
  assert.ok(url.length <= FEEDBACK_MAX_URL_LENGTH, `url was ${url.length} characters`);
  const body = new URL(url).searchParams.get('body') ?? '';
  assert.match(body, /…/);
  assert.match(body, /PARENO: 0\.4\.0/);
});

test('malformed text and code-point boundaries cannot break url encoding', () => {
  const emojiBoundaryModel = { ...environment, model: `${'a'.repeat(79)}😀` };
  const description = `${'😀'.repeat(5000)}abc\uD800def`;
  const url = buildFeedbackIssueUrl(description, emojiBoundaryModel);
  assert.ok(url.startsWith(`${FEEDBACK_ISSUES_URL}?title=`));
  assert.ok(url.length <= FEEDBACK_MAX_URL_LENGTH);
  const parsed = new URL(url);
  assert.ok((parsed.searchParams.get('title') ?? '').length > 0);
  assert.match(parsed.searchParams.get('body') ?? '', /PARENO: 0\.4\.0/);
  assert.match(sanitizeFeedbackDescription('abc\uD800def'), /^abc\uFFFDdef$/);
});

test('copyable report works without a GitHub account', () => {
  const report = buildFeedbackReport('模型返回空内容', environment);
  assert.match(report, /PARENO 反馈 \/ Feedback/);
  assert.match(report, /问题描述：\n模型返回空内容/);
  assert.match(report, /PARENO: 0\.4\.0/);
  assert.match(report, /提交地址：https:\/\/github\.com\/Jorgut\/pareno\/issues\/new/);
  assert.match(buildFeedbackReport('', environment), /（未填写）/);
});

const draft = { category: 'bug', message: '全文审校到第 3 段时停止，但原文没有修改。', email: 'writer@example.com' };

test('feedback draft validation covers empty, long and invalid email input', () => {
  assert.equal(validateFeedbackDraft(draft), null);
  assert.equal(validateFeedbackDraft({ ...draft, email: '' }), null);
  assert.equal(validateFeedbackDraft({ ...draft, message: '   ' }), 'empty');
  assert.equal(validateFeedbackDraft({ ...draft, message: '长'.repeat(MAX_FEEDBACK_MESSAGE + 1) }), 'too-long');
  assert.equal(validateFeedbackDraft({ ...draft, email: 'not-an-email' }), 'email-invalid');
  assert.equal(validateFeedbackDraft({ ...draft, email: 'a@b' }), 'email-invalid');
  assert.equal(validateFeedbackDraft({ ...draft, email: `${'a'.repeat(245)}@example.com` }), 'email-invalid');
});

test('feedback categories have stable values and labels', () => {
  assert.deepEqual(FEEDBACK_CATEGORIES.map(item => item.value), ['bug', 'suggestion', 'quality', 'other']);
  for (const item of FEEDBACK_CATEGORIES) assert.equal(feedbackCategoryLabel(item.value), item.label);
});

test('feedback delivery is only configured with a non-empty endpoint', () => {
  assert.equal(isFeedbackDeliveryConfigured(''), false);
  assert.equal(isFeedbackDeliveryConfigured('   '), false);
  assert.equal(isFeedbackDeliveryConfigured('https://formspree.io/f/test'), true);
  assert.equal(isFeedbackDeliveryConfigured(), FEEDBACK_SUBMIT_ENDPOINT.trim().length > 0);
});

test('submission payload targets the endpoint and carries user input plus diagnostics only', () => {
  const submission = buildFeedbackSubmission(draft, {
    ...environment,
    apiKey: 'sk-must-not-leak',
    endpoint: 'http://internal.example/v1',
    filePath: 'Private/未发表文章.md'
  }, 'https://formspree.io/f/test');
  assert.equal(submission.url, 'https://formspree.io/f/test');
  assert.equal(submission.payload._subject, '[PARENO] 反馈 · 问题 / Bug');
  assert.equal(submission.payload.category, '问题 / Bug');
  assert.equal(submission.payload.message, draft.message);
  assert.equal(submission.payload.email, 'writer@example.com');
  assert.equal(submission.payload._gotcha, '');
  assert.match(submission.payload.environment, /PARENO: 0\.4\.0/);
  const serialized = JSON.stringify(submission.payload);
  assert.doesNotMatch(serialized, /sk-must-not-leak|internal\.example|未发表文章/);
  assert.doesNotMatch(serialized, /access_key/);
  const withoutEmail = buildFeedbackSubmission({ ...draft, email: '' }, environment, 'https://formspree.io/f/test');
  assert.equal('email' in withoutEmail.payload, false);
  assert.throws(() => buildFeedbackSubmission(draft, environment, '   '), /not configured/);
});

test('delivery response parsing maps provider states to actionable results', () => {
  assert.deepEqual(parseFeedbackDelivery(200, { ok: true }), { ok: true });
  assert.deepEqual(parseFeedbackDelivery(200, { success: true }), { ok: true });
  assert.deepEqual(parseFeedbackDelivery(429, { error: 'rate' }), { ok: false, reason: 'rate' });
  assert.deepEqual(parseFeedbackDelivery(400, { errors: [] }), { ok: false, reason: 'invalid' });
  assert.deepEqual(parseFeedbackDelivery(500, { statusCode: 500 }), { ok: false, reason: 'unavailable' });
  assert.deepEqual(parseFeedbackDelivery(200, {}), { ok: false, reason: 'unavailable' });
  assert.deepEqual(parseFeedbackDelivery(0, null), { ok: false, reason: 'unavailable' });
});

test('copy text mirrors the submission for manual fallback', () => {
  const text = buildFeedbackCopyText(draft, environment);
  assert.match(text, /类型：问题 \/ Bug/);
  assert.match(text, /问题描述：\n全文审校到第 3 段时停止/);
  assert.match(text, /联系邮箱：writer@example\.com/);
  assert.match(text, /PARENO: 0\.4\.0/);
  const withoutEmail = buildFeedbackCopyText({ ...draft, email: '', message: '' }, environment);
  assert.match(withoutEmail, /（未填写）/);
  assert.doesNotMatch(withoutEmail, /联系邮箱/);
});

