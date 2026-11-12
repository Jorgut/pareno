// Cloudflare Pages Function: POST /api/feedback
// Receives text-only feedback and creates a private GitHub issue.

const MAX_BODY_BYTES = 8 * 1024;
const MAX_MESSAGE = 2000;
const MAX_ENVIRONMENT = 1200;
const MAX_CATEGORY = 60;
const MAX_EMAIL = 254;
const DELIVERY_TIMEOUT_MS = 8000;
const ALLOWED_FIELDS = new Set(['category', 'message', 'email', 'environment', '_subject', '_gotcha']);
const CATEGORY_LABELS = new Set(['问题 / Bug', '功能建议', '翻译或建议质量', '其他']);
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>.]+(?:\.[^\s@<>.]+)+$/;
const REPO_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9_.-]{1,100}$/;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept'
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...CORS_HEADERS
    }
  });
}

function readConfiguration(env) {
  const token = env?.FEEDBACK_GITHUB_TOKEN;
  const repo = env?.FEEDBACK_REPO;
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) return null;
  if (typeof repo !== 'string' || !REPO_PATTERN.test(repo) || repo.endsWith('/.') || repo.endsWith('/..')) return null;
  return { token: token.trim(), repo };
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, maxLength);
}

// Encode punctuation as entities before GitHub parses Markdown. This keeps
// mentions, images, HTML, code fences and links inert in the private issue.
function plainText(value) {
  return String(value).replace(/[^\p{L}\p{N}\s]/gu, character => `&#${character.codePointAt(0)};`);
}

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Object.keys(body).some(key => !ALLOWED_FIELDS.has(key))) return null;
  for (const key of ALLOWED_FIELDS) {
    if (body[key] !== undefined && typeof body[key] !== 'string') return null;
  }
  if (typeof body._gotcha === 'string' && body._gotcha.trim()) return null;

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message || [...message].length > MAX_MESSAGE) return null;
  const requestedCategory = cleanText(body.category || '其他', MAX_CATEGORY);
  const category = CATEGORY_LABELS.has(requestedCategory) ? requestedCategory : '其他';
  const environment = cleanText(body.environment || '', MAX_ENVIRONMENT);
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (email && ([...email].length > MAX_EMAIL || !EMAIL_PATTERN.test(email))) return null;
  return { message, category, environment, email };
}

function issueBody(input) {
  return [
    '## 反馈类型',
    plainText(input.category),
    '',
    '## 问题描述',
    plainText(input.message),
    '',
    '## 联系邮箱',
    plainText(input.email || '（未提供）'),
    '',
    '## 环境信息',
    plainText(input.environment || '（未提供）'),
    '',
    '## 来源',
    'PARENO 反馈入口'
  ].join('\n');
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet({ env }) {
  return jsonResponse(200, { enabled: Boolean(readConfiguration(env)) });
}

export async function onRequestPost({ request, env }) {
  const configuration = readConfiguration(env);
  if (!configuration) return jsonResponse(503, { error: 'Feedback unavailable.' });

  const contentType = request.headers.get('content-type') || '';
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType)) {
    return jsonResponse(415, { error: 'JSON required.' });
  }

  let raw;
  try {
    raw = await request.text();
  } catch {
    return jsonResponse(400, { error: 'Invalid feedback.' });
  }
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return jsonResponse(413, { error: 'Feedback too large.' });
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonResponse(400, { error: 'Invalid feedback.' });
  }

  const input = validate(body);
  if (!input) return jsonResponse(400, { error: 'Invalid feedback.' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.github.com/repos/${configuration.repo}/issues`, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${configuration.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'PARENO-Feedback'
      },
      body: JSON.stringify({
        title: `[PARENO] ${input.category}`,
        body: issueBody(input)
      })
    });
    // Never read, return or log GitHub's private response or errors.
    if (!response || response.status !== 201) {
      return jsonResponse(502, { error: 'Feedback delivery unavailable.' });
    }
    return jsonResponse(201, { ok: true, receipt: crypto.randomUUID() });
  } catch (error) {
    return jsonResponse(502, { error: 'Feedback delivery unavailable.' });
  } finally {
    clearTimeout(timer);
  }
}
