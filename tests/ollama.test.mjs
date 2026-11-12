import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasOllamaModel, normalizeOllamaModel, ollamaStatusLabel, parseOllamaModels } from '../src/ollama.ts';

test('parses Ollama /api/tags and OpenAI-compatible /v1/models payloads', () => {
  assert.deepEqual(parseOllamaModels({ models: [{ name: 'gpt-oss:20b' }, { name: 'qwen2.5:7b' }] }), ['gpt-oss:20b', 'qwen2.5:7b']);
  assert.deepEqual(parseOllamaModels({ data: [{ id: 'gpt-oss:20b' }] }), ['gpt-oss:20b']);
  assert.deepEqual(parseOllamaModels({ models: [{ name: '' }, {}, null] }), []);
  assert.deepEqual(parseOllamaModels(null), []);
  assert.deepEqual(parseOllamaModels({}), []);
});

test('normalizes the implicit :latest suffix when comparing models', () => {
  assert.equal(normalizeOllamaModel('qwen2.5:7b:latest'), 'qwen2.5:7b');
  assert.equal(normalizeOllamaModel('qwen2.5:7b'), 'qwen2.5:7b');
  assert.equal(hasOllamaModel(['qwen2.5:7b'], 'qwen2.5:7b:latest'), true);
  assert.equal(hasOllamaModel(['qwen2.5:7b:latest'], 'qwen2.5:7b'), true);
  assert.equal(hasOllamaModel(['qwen2.5:7b'], 'gpt-oss:20b'), false);
  assert.equal(hasOllamaModel([], 'qwen2.5:7b'), false);
});

test('status labels distinguish running, missing, stopped and unavailable models', () => {
  const running = { state: 'running', models: ['gpt-oss:20b'], message: '', checkedAt: 1 };
  assert.match(ollamaStatusLabel(running, 'gpt-oss:20b'), /已连接/);
  const missingModel = ollamaStatusLabel(running, 'qwen2.5:7b');
  assert.match(missingModel, /尚未安装/);
  assert.equal(ollamaStatusLabel({ state: 'stopped', models: [], message: '', checkedAt: 1 }, ''), 'Ollama 未启动');
  assert.equal(ollamaStatusLabel({ state: 'stopped', models: [], message: '正在启动 Ollama…', checkedAt: 0 }, ''), '正在启动 Ollama…');
  assert.equal(ollamaStatusLabel({ state: 'missing', models: [], message: '', checkedAt: 1 }, ''), '未找到 Ollama 安装');
  assert.equal(ollamaStatusLabel({ state: 'unknown', models: [], message: '', checkedAt: 0 }, ''), '正在检查 Ollama…');
});
