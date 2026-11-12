import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentLabel, agentOptions, agentStatusLabel, agentStatusSummary, defaultAgentStatuses,
  isAgentKind, parseAgentVersion
} from '../src/agents.ts';

test('recognizes supported local agent kinds', () => {
  assert.equal(isAgentKind('codex'), true);
  assert.equal(isAgentKind('claude'), true);
  assert.equal(isAgentKind('cursor-agent'), true);
  assert.equal(isAgentKind('opencode'), true);
  assert.equal(isAgentKind('gemini'), false);
  assert.equal(agentLabel('claude'), 'Claude Code');
  assert.equal(agentLabel('cursor-agent'), 'Cursor Agent');
});

test('parses version output from Codex, Claude Code, Cursor and OpenCode', () => {
  assert.equal(parseAgentVersion('codex-cli 0.164.0'), '0.164.0');
  assert.equal(parseAgentVersion('2.1.268 (Claude Code)'), '2.1.268');
  assert.equal(parseAgentVersion('1.19.5'), '1.19.5');
  assert.equal(parseAgentVersion('agent 2026.11.1\n'), '2026.11.1');
  assert.equal(parseAgentVersion(''), '');
});

test('status labels and summaries distinguish ready, missing and errors', () => {
  const statuses = defaultAgentStatuses();
  assert.equal(statuses.length, 4);
  assert.match(agentStatusSummary(statuses), /正在检测/);
  const ready = { ...statuses[1], state: 'ready', version: '2.1.268', checkedAt: 1 };
  assert.equal(agentStatusLabel(ready), 'Claude Code 2.1.268');
  assert.match(agentStatusSummary([ready]), /Claude Code/);
  assert.equal(agentStatusLabel({ ...ready, state: 'missing' }), 'Claude Code 未检测到');
  assert.equal(agentStatusLabel({ ...ready, state: 'error', message: '无法启动' }), '无法启动');
  const options = agentOptions([ready, ...statuses.filter(item => item.kind !== 'claude')]);
  assert.equal(options.find(option => option.value === 'claude').available, true);
  assert.equal(options.find(option => option.value === 'codex').available, false);
  assert.match(options.find(option => option.value === 'codex').label, /未检测到/);
});
