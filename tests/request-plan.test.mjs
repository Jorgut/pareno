import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OLLAMA_CLOUD_ENDPOINT, parseAgentOutput, parseClaudeOutput, parseCodexOutput, parseCursorOutput,
  parseOpencodeOutput, planRequest, renderPrompt
} from '../src/request-plan.ts';

function settings(overrides = {}) {
  return {
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
    ...overrides
  };
}

test('local Ollama requests stay on the local endpoint without authorization', () => {
  const plan = planRequest(settings());
  assert.equal(plan.transport, 'http');
  assert.equal(plan.url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(plan.headers.Authorization, undefined);
});

test('Ollama cloud requests use ollama.com and require a key', () => {
  assert.throws(() => planRequest(settings({ ollamaCloud: true })), /密钥/);
  const plan = planRequest(settings({ ollamaCloud: true, ollamaApiKey: 'test-key' }));
  assert.equal(plan.transport, 'http');
  assert.equal(plan.url, OLLAMA_CLOUD_ENDPOINT);
  assert.equal(plan.headers.Authorization, 'Bearer test-key');
});

test('OpenAI-compatible requests require an API key', () => {
  assert.throws(() => planRequest(settings({ provider: 'openai', endpoint: 'https://example.com/v1/chat/completions' })), /密钥/);
  const plan = planRequest(settings({ provider: 'openai', endpoint: 'https://example.com/v1/chat/completions', apiKey: 'sk-test' }));
  assert.equal(plan.url, 'https://example.com/v1/chat/completions');
  assert.equal(plan.headers.Authorization, 'Bearer sk-test');
});

test('each local agent maps to its non-interactive CLI invocation', () => {
  const codex = planRequest(settings({ provider: 'codex' }));
  assert.equal(codex.transport, 'cli');
  assert.match(codex.command, /(^|\/)codex$/);
  assert.equal(codex.prompt, 'stdin');
  assert.deepEqual(codex.args.slice(0, 3), ['exec', '--json', '--ephemeral']);

  const claude = planRequest(settings({ provider: 'claude', model: 'sonnet' }));
  assert.equal(claude.transport, 'cli');
  assert.match(claude.command, /(^|\/)claude$/);
  assert.equal(claude.prompt, 'stdin');
  assert.deepEqual(claude.args, ['-p', '--output-format', 'json', '--tools', '', '--model', 'sonnet']);

  const cursor = planRequest(settings({ provider: 'cursor-agent', model: '' }));
  assert.equal(cursor.transport, 'cli');
  assert.equal(cursor.prompt, 'arg');
  assert.deepEqual(cursor.args, ['-p', '--output-format', 'json', '--mode', 'ask', '--trust']);

  const opencode = planRequest(settings({ provider: 'opencode', model: 'anthropic/claude-sonnet-4' }));
  assert.equal(opencode.transport, 'cli');
  assert.equal(opencode.prompt, 'arg');
  assert.deepEqual(opencode.args, ['run', '--format', 'json', '--pure', '--model', 'anthropic/claude-sonnet-4']);
});

test('agent output parsers handle success payloads and errors', () => {
  assert.equal(parseClaudeOutput(JSON.stringify({ is_error: false, result: '修订稿' })), '修订稿');
  assert.throws(() => parseClaudeOutput(JSON.stringify({ is_error: true, result: '额度不足' })), /额度不足/);
  assert.equal(parseCursorOutput(JSON.stringify({ type: 'result', result: '建议' })), '建议');
  assert.equal(parseOpencodeOutput('{"type":"text","text":"第一段"}\n{"type":"text","text":"第二段"}'), '第一段第二段');
  const codex = [
    '{"type":"item.completed","item":{"type":"agent_message","text":"段落建议"}}',
    '{"type":"turn.completed"}'
  ].join('\n');
  assert.equal(parseCodexOutput(codex), '段落建议');
  assert.throws(() => parseCodexOutput('{"type":"turn.failed","error":{"message":"失败原因"}}'), /失败原因/);
  assert.equal(parseAgentOutput('claude', JSON.stringify({ result: 'x' })), 'x');
});

test('prompt rendering keeps roles and separates messages', () => {
  assert.equal(renderPrompt([{ role: 'system', content: '规则' }, { role: 'user', content: '原文' }]), 'SYSTEM:\n规则\n\nUSER:\n原文');
});
