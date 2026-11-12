import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

export type AgentKind = 'codex' | 'claude' | 'cursor-agent' | 'opencode';
export type AgentState = 'unknown' | 'ready' | 'missing' | 'error';

export interface AgentDefinition {
  kind: AgentKind;
  label: string;
  executable: string;
  versionArgs: string[];
  hint: string;
}

export interface AgentStatus {
  kind: AgentKind;
  label: string;
  executable: string;
  state: AgentState;
  version: string;
  message: string;
  checkedAt: number;
}

export const AGENT_DEFINITIONS: readonly AgentDefinition[] = [
  {
    kind: 'codex',
    label: 'Codex CLI',
    executable: 'codex',
    versionArgs: ['--version'],
    hint: '使用本机 Codex 登录，只读沙箱执行。'
  },
  {
    kind: 'claude',
    label: 'Claude Code',
    executable: 'claude',
    versionArgs: ['--version'],
    hint: '使用本机 Claude Code 登录，打印模式并禁用工具。'
  },
  {
    kind: 'cursor-agent',
    label: 'Cursor Agent',
    executable: 'cursor-agent',
    versionArgs: ['--version'],
    hint: '使用 Cursor Agent 登录，ask 只读模式。'
  },
  {
    kind: 'opencode',
    label: 'OpenCode',
    executable: 'opencode',
    versionArgs: ['--version'],
    hint: '使用 OpenCode 已配置的模型，纯模式运行。'
  }
];

export const AGENT_KINDS: AgentKind[] = AGENT_DEFINITIONS.map(definition => definition.kind);

export function isAgentKind(value: string): value is AgentKind {
  return (AGENT_KINDS as string[]).includes(value);
}

export function agentDefinition(kind: AgentKind): AgentDefinition {
  return AGENT_DEFINITIONS.find(definition => definition.kind === kind) ?? AGENT_DEFINITIONS[0];
}

export function agentLabel(kind: AgentKind): string {
  return agentDefinition(kind).label;
}

export function defaultAgentStatuses(): AgentStatus[] {
  return AGENT_DEFINITIONS.map(definition => ({
    kind: definition.kind,
    label: definition.label,
    executable: definition.executable,
    state: 'unknown',
    version: '',
    message: '',
    checkedAt: 0
  }));
}

export function parseAgentVersion(output: string): string {
  const line = output.split('\n').map(part => part.trim()).find(part => part.length > 0) ?? '';
  const match = line.match(/v?(\d+\.\d+(?:\.\d+)?)/);
  return match ? match[0] : line.slice(0, 60);
}

export function agentStatusLabel(status: AgentStatus): string {
  if (status.state === 'ready') return status.version ? `${status.label} ${status.version}` : status.label;
  if (status.state === 'missing') return `${status.label} 未检测到`;
  if (status.state === 'error') return status.message || `${status.label} 无法运行`;
  return `正在检测 ${status.label}…`;
}

export function agentStatusSummary(statuses: AgentStatus[]): string {
  const ready = statuses.filter(status => status.state === 'ready');
  if (ready.length) return `本机 Agent：${ready.map(status => status.label).join('、')}`;
  if (statuses.some(status => status.state === 'unknown')) return '正在检测本机 Agent…';
  return '未检测到可用的本机 Agent CLI';
}

export interface AgentOption {
  value: AgentKind;
  label: string;
  available: boolean;
}

export function agentOptions(statuses: AgentStatus[]): AgentOption[] {
  return AGENT_DEFINITIONS.map(definition => {
    const status = statuses.find(item => item.kind === definition.kind);
    const ready = status?.state === 'ready';
    return {
      value: definition.kind,
      label: ready ? `${definition.label} · 可用` : `${definition.label} · 未检测到`,
      available: ready
    };
  });
}

export function resolveAgentCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed || isAbsolute(trimmed)) return trimmed;
  const home = homedir();
  const directories = (process.env.PATH || '').split(delimiter).filter(Boolean);
  for (const directory of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', join(home, '.local', 'bin'), join(home, '.bun', 'bin'), join(home, '.npm-global', 'bin'), join(home, '.cargo', 'bin')]) {
    if (!directories.includes(directory)) directories.push(directory);
  }
  for (const directory of directories) {
    const candidate = join(directory, trimmed);
    if (existsSync(candidate)) return candidate;
  }
  return trimmed;
}
