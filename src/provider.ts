import { requestUrl } from 'obsidian';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

export type Provider = 'ollama' | 'openai' | 'codex';
export interface ProviderSettings { provider: Provider; endpoint: string; model: string; apiKey: string; codexExecutable: string }

export async function requestWritingModel(settings: ProviderSettings, messages: Array<{ role: string; content: string }>, cancelled: () => boolean): Promise<string> {
  if (settings.provider === 'codex') return requestCodex(settings.codexExecutable, messages, cancelled);
  if (settings.provider === 'openai' && !settings.apiKey.trim()) throw new Error('请在 PARENO 设置中填写 API 密钥。');
  const response = await requestUrl({
    url: settings.endpoint.trim(), method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(settings.provider === 'openai' ? { Authorization: `Bearer ${settings.apiKey.trim()}` } : {}) },
    body: JSON.stringify({ model: settings.model.trim(), messages, temperature: 0.2, stream: false })
  });
  if (cancelled()) throw new Error('已停止本次请求。');
  const content: unknown = response.json?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => part?.text ?? '').join('');
  throw new Error('模型没有返回可读取的内容。');
}

async function requestCodex(executable: string, messages: Array<{ role: string; content: string }>, cancelled: () => boolean): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'pareno-writing-'));
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    if (cancelled()) throw new Error('已停止本次请求。');
    const command = executable.trim() || 'codex';
    const prompt = messages.map(message => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n');
    return await new Promise<string>((resolve, reject) => {
      child = spawn(command, [
        'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
        '--skip-git-repo-check', '--sandbox', 'read-only', '--disable', 'shell_tool',
        '-c', 'model_reasoning_effort="low"', '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"', '-'
      ], { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: {
        ...process.env,
        PATH: isAbsolute(command) ? [dirname(command), process.env.PATH || ''].join(delimiter) : process.env.PATH
      } });
      let output = '';
      let errorOutput = '';
      let settled = false;
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        clearInterval(watch);
        clearTimeout(timeout);
        if (error) reject(error); else resolve(value ?? '');
      };
      const watch = setInterval(() => { if (cancelled()) { child?.kill(); finish(new Error('已停止本次请求。')); } }, 250);
      const timeout = setTimeout(() => { child?.kill(); finish(new Error('Codex 请求超时，请重试。')); }, 180000);
      child.stdout.on('data', chunk => { output += chunk.toString(); });
      child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk.toString()).slice(-4000); });
      child.on('error', error => finish(error));
      child.on('close', code => {
        if (cancelled()) return finish(new Error('已停止本次请求。'));
        const events = output.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        const failed = events.find(event => event.type === 'turn.failed' || event.type === 'error');
        if (code !== 0 || failed) return finish(new Error(failed?.error?.message || failed?.message || errorOutput || `Codex exited ${code}`));
        if (!events.some(event => event.type === 'turn.completed')) return finish(new Error('Codex 请求未完成。'));
        const text = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').map(event => event.item.text).join('\n');
        if (!text) return finish(new Error('Codex 没有返回内容。'));
        finish(undefined, text);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  } finally {
    child?.kill();
    await rm(cwd, { recursive: true, force: true });
  }
}
