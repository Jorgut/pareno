import { agentDefinition, resolveAgentCommand } from './agents.ts';
import type { AgentKind } from './agents.ts';

export type Provider = 'ollama' | 'openai' | AgentKind;

export interface ProviderSettings {
  provider: Provider;
  endpoint: string;
  model: string;
  apiKey: string;
  ollamaApiKey: string;
  ollamaCloud: boolean;
  codexExecutable: string;
  claudeExecutable: string;
  cursorExecutable: string;
  opencodeExecutable: string;
}

export const OLLAMA_CLOUD_ENDPOINT = 'https://ollama.com/v1/chat/completions';

export type RequestPlan =
  | { transport: 'http'; url: string; headers: Record<string, string> }
  | { transport: 'cli'; command: string; args: string[]; prompt: 'stdin' | 'arg'; label: string; provider: AgentKind };

export function agentExecutable(settings: ProviderSettings, kind: AgentKind): string {
  const configured = {
    codex: settings.codexExecutable,
    claude: settings.claudeExecutable,
    'cursor-agent': settings.cursorExecutable,
    opencode: settings.opencodeExecutable
  }[kind];
  return (configured ?? '').trim() || agentDefinition(kind).executable;
}

export function planRequest(settings: ProviderSettings): RequestPlan {
  if (settings.provider === 'ollama') {
    if (settings.ollamaCloud) {
      if (!settings.ollamaApiKey.trim()) {
        throw new Error('使用 Ollama 云端模型需要先在设置中填入 ollama.com API 密钥（ollama.com/settings/keys）。');
      }
      return {
        transport: 'http',
        url: OLLAMA_CLOUD_ENDPOINT,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.ollamaApiKey.trim()}` }
      };
    }
    return { transport: 'http', url: settings.endpoint.trim(), headers: { 'Content-Type': 'application/json' } };
  }
  if (settings.provider === 'openai') {
    if (!settings.apiKey.trim()) throw new Error('请在 PARENO 设置中填写 API 密钥。');
    return {
      transport: 'http',
      url: settings.endpoint.trim(),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey.trim()}` }
    };
  }
  const definition = agentDefinition(settings.provider);
  const command = resolveAgentCommand(agentExecutable(settings, settings.provider));
  const modelArgs = settings.model.trim() ? ['--model', settings.model.trim()] : [];
  if (settings.provider === 'codex') {
    return {
      transport: 'cli',
      command,
      label: definition.label,
      prompt: 'stdin',
      provider: settings.provider,
      args: [
        'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
        '--skip-git-repo-check', '--sandbox', 'read-only', '--disable', 'shell_tool',
        '-c', 'model_reasoning_effort="low"', '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"', '-'
      ]
    };
  }
  if (settings.provider === 'claude') {
    return {
      transport: 'cli',
      command,
      label: definition.label,
      prompt: 'stdin',
      provider: settings.provider,
      args: ['-p', '--output-format', 'json', '--tools', '', ...modelArgs]
    };
  }
  if (settings.provider === 'cursor-agent') {
    return {
      transport: 'cli',
      command,
      label: definition.label,
      prompt: 'arg',
      provider: settings.provider,
      args: ['-p', '--output-format', 'json', '--mode', 'ask', '--trust', ...modelArgs]
    };
  }
  return {
    transport: 'cli',
    command,
    label: definition.label,
    prompt: 'arg',
    provider: settings.provider,
    args: ['run', '--format', 'json', '--pure', ...modelArgs]
  };
}

export function renderPrompt(messages: Array<{ role: string; content: string }>): string {
  return messages.map(message => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n');
}

export function parseAgentOutput(provider: AgentKind, output: string): string {
  if (provider === 'codex') return parseCodexOutput(output);
  if (provider === 'claude') return parseClaudeOutput(output);
  if (provider === 'cursor-agent') return parseCursorOutput(output);
  return parseOpencodeOutput(output);
}

export function parseClaudeOutput(output: string): string {
  const payload = parseJsonObject(output);
  if (!payload) throw new Error('Claude Code 没有返回可读取的 JSON。');
  if (payload.is_error) {
    throw new Error(typeof payload.result === 'string' && payload.result.trim() ? payload.result : 'Claude Code 返回了错误。');
  }
  const result = payload.result;
  if (typeof result === 'string' && result.trim()) return result;
  throw new Error('Claude Code 没有返回内容。');
}

export function parseCursorOutput(output: string): string {
  const payload = parseJsonObject(output);
  if (!payload) throw new Error('Cursor Agent 没有返回可读取的 JSON。');
  for (const key of ['result', 'text', 'message']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  throw new Error('Cursor Agent 没有返回内容。');
}

export function parseOpencodeOutput(output: string): string {
  const parts: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
    if (event.type === 'text' && typeof event.text === 'string') parts.push(event.text);
    else if (event.part && typeof event.part === 'object' && (event.part as Record<string, unknown>).type === 'text') {
      const text = (event.part as Record<string, unknown>).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  const joined = parts.join('').trim();
  if (joined) return joined;
  throw new Error('OpenCode 没有返回内容。');
}

export function parseCodexOutput(output: string): string {
  const events = output.split('\n').flatMap(line => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
  const failed = events.find(event => event.type === 'turn.failed' || event.type === 'error');
  if (failed) {
    const error = failed.error as Record<string, unknown> | undefined;
    throw new Error((typeof error?.message === 'string' && error.message) || (typeof failed.message === 'string' && failed.message) || 'Codex 请求失败。');
  }
  if (!events.some(event => event.type === 'turn.completed')) throw new Error('Codex 请求未完成。');
  const text = events
    .filter(event => event.type === 'item.completed' && (event.item as Record<string, unknown> | undefined)?.type === 'agent_message')
    .map(event => String((event.item as Record<string, unknown>).text ?? ''))
    .join('\n');
  if (!text.trim()) throw new Error('Codex 没有返回内容。');
  return text;
}

function parseJsonObject(output: string): Record<string, unknown> | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  try {
    const value = JSON.parse(trimmed);
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  } catch {
    const line = trimmed.split('\n').reverse().find(part => part.trim().startsWith('{'));
    if (!line) return undefined;
    try {
      const value = JSON.parse(line);
      return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }
}
