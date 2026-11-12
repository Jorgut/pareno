import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasOllamaCloudModel, hasOllamaModel, normalizeOllamaModel, ollamaStatusLabel,
  parseOllamaCloudModels, parseOllamaModels
} from '../src/ollama.ts';

function status(overrides = {}) {
  return { state: 'running', models: [], cloudModels: [], cloudError: '', message: '', checkedAt: 1, ...overrides };
}

test('parses Ollama /api/tags and OpenAI-compatible /v1/models payloads', () => {
  assert.deepEqual(parseOllamaModels({ models: [{ name: 'gpt-oss:20b' }, { name: 'qwen2.5:7b' }] }), ['gpt-oss:20b', 'qwen2.5:7b']);
  assert.deepEqual(parseOllamaModels({ data: [{ id: 'gpt-oss:20b' }] }), ['gpt-oss:20b']);
  assert.deepEqual(parseOllamaModels({ models: [{ name: '' }, {}, null] }), []);
  assert.deepEqual(parseOllamaModels(null), []);
  assert.deepEqual(parseOllamaModels({}), []);
});

test('parses the public ollama.com cloud catalog', () => {
  const catalog = { models: [{ name: 'kimi-k3' }, { name: 'gemma4:31b' }, { name: 'kimi-k3' }] };
  assert.deepEqual(parseOllamaCloudModels(catalog), ['kimi-k3', 'gemma4:31b']);
  assert.deepEqual(parseOllamaCloudModels({ data: [{ id: 'glm-5.2' }] }), ['glm-5.2']);
  assert.deepEqual(parseOllamaCloudModels(null), []);
});

test('normalizes the implicit :latest suffix when comparing models', () => {
  assert.equal(normalizeOllamaModel('qwen2.5:7b:latest'), 'qwen2.5:7b');
  assert.equal(normalizeOllamaModel('qwen2.5:7b'), 'qwen2.5:7b');
  assert.equal(hasOllamaModel(['qwen2.5:7b'], 'qwen2.5:7b:latest'), true);
  assert.equal(hasOllamaModel(['qwen2.5:7b:latest'], 'qwen2.5:7b'), true);
  assert.equal(hasOllamaModel(['qwen2.5:7b'], 'gpt-oss:20b'), false);
  assert.equal(hasOllamaModel([], 'qwen2.5:7b'), false);
  assert.equal(hasOllamaCloudModel(status({ cloudModels: ['kimi-k3'] }), 'kimi-k3'), true);
  assert.equal(hasOllamaCloudModel(status({ cloudModels: ['kimi-k3'] }), 'gemma4:31b'), false);
});

test('status labels distinguish running, missing, stopped and unavailable models', () => {
  const running = status({ models: ['gpt-oss:20b'], cloudModels: ['kimi-k3', 'glm-5.2'], checkedAt: 1 });
  assert.match(ollamaStatusLabel(running, 'gpt-oss:20b'), /已连接/);
  assert.match(ollamaStatusLabel(running, 'gpt-oss:20b'), /云端目录 2 个/);
  const missingModel = ollamaStatusLabel(running, 'qwen2.5:7b');
  assert.match(missingModel, /尚未安装/);
  assert.match(ollamaStatusLabel(running, 'kimi-k3', true), /云端目录 2 个模型/);
  assert.match(ollamaStatusLabel(status({ cloudModels: ['kimi-k3'], cloudError: '无法连接' }), '', true), /云端目录 1 个模型/);
  assert.match(ollamaStatusLabel(status({ cloudModels: ['kimi-k3'] }), 'glm-5.2', true), /没有 glm-5.2/);
  assert.match(ollamaStatusLabel(status({ cloudModels: [], cloudError: '无法连接 ollama.com' }), '', true), /读取失败/);
  assert.equal(ollamaStatusLabel({ state: 'stopped', models: [], cloudModels: [], cloudError: '', message: '', checkedAt: 1 }, ''), 'Ollama 未启动');
  assert.equal(ollamaStatusLabel({ state: 'stopped', models: [], cloudModels: [], cloudError: '', message: '正在启动 Ollama…', checkedAt: 0 }, ''), '正在启动 Ollama…');
  assert.equal(ollamaStatusLabel({ state: 'missing', models: [], cloudModels: [], cloudError: '', message: '', checkedAt: 1 }, ''), '未找到 Ollama 安装');
  assert.equal(ollamaStatusLabel({ state: 'unknown', models: [], cloudModels: [], cloudError: '', message: '', checkedAt: 0 }, ''), '正在检查 Ollama…');
});
