import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet, onRequestOptions, onRequestPost } from '../website/functions/api/feedback.js';

const ENV = {
  FEEDBACK_GITHUB_TOKEN: 'server-only-secret',
  FEEDBACK_REPO: 'private-owner/private-inbox'
};

function makeRequest(body, { method = 'POST', headers = {}, contentType = 'application/json; charset=utf-8' } = {}) {
  const init = { method, headers: { ...(contentType ? { 'content-type': contentType } : {}), ...headers } };
  if (method === 'POST') init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('https://pareno.test/api/feedback', init);
}

async function withFetch(fetchImpl, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push([url, options]);
    return fetchImpl(url, options);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const validBody = {
  category: '问题 / Bug',
  message: '全文审校到第 3 段时停止，但原文没有修改。',
  email: 'writer@example.com',
  environment: 'PARENO: 0.5.0\nObsidian API: 1.8.7',
  _subject: '[PARENO] 反馈 · 问题 / Bug',
  _gotcha: ''
};

test('GET exposes only the enabled flag', async () => {
  assert.deepEqual(await (await onRequestGet({ env: ENV })).json(), { enabled: true });
  assert.deepEqual(await (await onRequestGet({ env: {} })).json(), { enabled: false });
  const response = await onRequestGet({ env: ENV });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

test('OPTIONS provides CORS headers', async () => {
  const response = await onRequestOptions();
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

test('valid feedback creates a private issue and returns an opaque receipt', async () => {
  await withFetch(async () => new Response('{}', { status: 201 }), async calls => {
    const response = await onRequestPost({ request: makeRequest(validBody), env: ENV });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.match(result.receipt, /^[0-9a-f-]{36}$/);
    assert.equal(calls.length, 1);
    const [url, options] = calls[0];
    assert.equal(url, 'https://api.github.com/repos/private-owner/private-inbox/issues');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer server-only-secret');
    assert.equal(options.redirect, 'manual');
    const issue = JSON.parse(options.body);
    assert.equal(issue.title, '[PARENO] 问题 / Bug');
    assert.match(issue.body, /全文审校到第 3 段时停止/);
    assert.match(issue.body, /writer&#64;example&#46;com/);
    assert.match(issue.body, /PARENO&#58; 0&#46;5&#46;0/);
    const text = JSON.stringify(result);
    for (const privateValue of ['server-only-secret', 'private-owner', '全文审校', 'writer@example.com']) {
      assert.equal(text.includes(privateValue), false);
    }
  });
});

test('user markdown, mentions, HTML and image embeds are inert', async () => {
  await withFetch(async () => new Response('{}', { status: 201 }), async calls => {
    const response = await onRequestPost({
      request: makeRequest({
        message: '@alice @org/team ![image](https://evil.test/a.png)\n<img src=x>\n```\n# heading\nhttps://github.com/user-attachments/assets/x',
        category: '其他'
      }),
      env: ENV
    });
    assert.equal(response.status, 201);
    const issue = JSON.parse(calls[0][1].body);
    for (const unsafe of ['@alice', '@org/team', '![image]', '<img', '```', 'https://']) {
      assert.equal(issue.body.includes(unsafe), false, unsafe);
    }
    assert.match(issue.body, /&#64;alice/);
  });
});

test('email is optional and invalid payloads are rejected before GitHub', async () => {
  await withFetch(async () => new Response('{}', { status: 201 }), async calls => {
    const withoutEmail = { ...validBody };
    delete withoutEmail.email;
    assert.equal((await onRequestPost({ request: makeRequest(withoutEmail), env: ENV })).status, 201);
    assert.match(JSON.parse(calls[0][1].body).body, /未提供/);
  });

  const invalid = [
    { ...validBody, message: '   ' },
    { ...validBody, message: '长'.repeat(2001) },
    { ...validBody, email: 'not-an-email' },
    { ...validBody, email: 'a@b' },
    { ...validBody, email: `${'a'.repeat(245)}@example.com` },
    { ...validBody, _gotcha: 'bot' },
    { ...validBody, unexpected: 'field' },
    { ...validBody, category: 12 },
    { ...validBody, message: {} },
    null,
    [],
    'text'
  ];
  await withFetch(async () => {
    throw new Error('must not be called');
  }, async calls => {
    for (const body of invalid) {
      const response = await onRequestPost({ request: makeRequest(body), env: ENV });
      assert.equal(response.status, 400, JSON.stringify(body));
    }
    assert.equal(calls.length, 0);
  });
});

test('rejects invalid JSON, wrong content type and oversized bodies', async () => {
  await withFetch(async () => new Response('{}', { status: 201 }), async calls => {
    assert.equal((await onRequestPost({ request: makeRequest('{bad'), env: ENV })).status, 400);
    assert.equal((await onRequestPost({ request: makeRequest(validBody, { contentType: 'text/plain' }), env: ENV })).status, 415);
    assert.equal((await onRequestPost({ request: makeRequest('x'.repeat(9000)), env: ENV })).status, 413);
    assert.equal(calls.length, 0);
  });
});

test('fails closed when unconfigured and hides provider failures', async () => {
  await withFetch(async () => new Response('{}', { status: 503 }), async calls => {
    assert.equal((await onRequestPost({ request: makeRequest(validBody), env: {} })).status, 503);
    const failed = await onRequestPost({
      request: makeRequest(validBody),
      env: { ...ENV }
    });
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), { error: 'Feedback delivery unavailable.' });
    assert.equal(calls.length, 1);
  });

  await withFetch(async () => { throw new Error('provider secret'); }, async () => {
    const response = await onRequestPost({ request: makeRequest(validBody), env: ENV });
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.doesNotMatch(text, /provider secret|server-only-secret|private-owner/);
  });
});

test('token and repository configuration is validated', async () => {
  const badEnvs = [
    {},
    { FEEDBACK_GITHUB_TOKEN: '', FEEDBACK_REPO: 'owner/repo' },
    { FEEDBACK_GITHUB_TOKEN: 'secret\r\nheader', FEEDBACK_REPO: 'owner/repo' },
    { FEEDBACK_GITHUB_TOKEN: 'secret', FEEDBACK_REPO: '../other' },
    { FEEDBACK_GITHUB_TOKEN: 'secret', FEEDBACK_REPO: 'owner/..' },
    { FEEDBACK_GITHUB_TOKEN: 'secret', FEEDBACK_REPO: 'owner/repo/extra' }
  ];
  for (const env of badEnvs) {
    assert.deepEqual(await (await onRequestGet({ env })).json(), { enabled: false });
    assert.equal((await onRequestPost({ request: makeRequest(validBody), env })).status, 503);
  }
});
