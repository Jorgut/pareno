import { requestUrl } from 'obsidian';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { OLLAMA_CLOUD_ENDPOINT, parseAgentOutput, planRequest, renderPrompt } from './request-plan';
import type { ProviderSettings, RequestPlan } from './request-plan';
import type { AgentKind } from './agents';

export * from './request-plan';

export async function requestWritingModel(settings: ProviderSettings, messages: Array<{ role: string; content: string }>, cancelled: () => boolean): Promise<string> {
  const plan = planRequest(settings);
  if (plan.transport === 'http') {
    let response;
    try {
      response = await requestUrl({
        url: plan.url,
        method: 'POST',
        headers: plan.headers,
        body: JSON.stringify({ model: settings.model.trim(), messages, temperature: 0.2, stream: false })
      });
    } catch (error) {
      if (plan.url === OLLAMA_CLOUD_ENDPOINT) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('401')) throw new Error('Ollama Cloud 密钥无效或缺失，请在 ollama.com/settings/keys 重新生成。');
        if (message.includes('429')) throw new Error('Ollama Cloud 免费额度或频率限制已达上限，请稍后再试，或改用本机模型。');
      }
      throw error;
    }
    if (cancelled()) throw new Error('已停止本次请求。');
    const content: unknown = response.json?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(part => part?.text ?? '').join('');
    throw new Error('模型没有返回可读取的内容。');
  }
  const output = await runCli(plan, renderPrompt(messages), cancelled);
  return parseAgentOutput(settings.provider as AgentKind, output);
}

async function runCli(plan: Extract<RequestPlan, { transport: 'cli' }>, prompt: string, cancelled: () => boolean): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'pareno-writing-'));
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    if (cancelled()) throw new Error('已停止本次请求。');
    return await new Promise<string>((resolve, reject) => {
      const args = plan.prompt === 'arg' ? [...plan.args, prompt] : plan.args;
      child = spawn(plan.command, args, {
        cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: isAbsolute(plan.command) ? [dirname(plan.command), process.env.PATH || ''].join(delimiter) : process.env.PATH
        }
      });
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
      const timeout = setTimeout(() => { child?.kill(); finish(new Error(`${plan.label} 请求超时，请重试。`)); }, 180000);
      child.stdout.on('data', chunk => { output += chunk.toString(); });
      child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk.toString()).slice(-4000); });
      child.on('error', error => finish(error));
      child.on('close', code => {
        if (cancelled()) return finish(new Error('已停止本次请求。'));
        if (code !== 0) {
          try {
            const parsed = parseAgentOutput(plan.provider, output);
            if (parsed.trim()) return finish(undefined, parsed);
          } catch (error) {
            const message = error instanceof Error ? error.message : '';
            if (message && !message.includes('请求未完成') && !message.includes('没有返回内容')) return finish(error as Error);
          }
          return finish(new Error(errorOutput.trim() || `${plan.label} exited ${code}`));
        }
        finish(undefined, output);
      });
      child.stdin.on('error', () => {});
      if (plan.prompt === 'stdin') child.stdin.end(prompt);
      else child.stdin.end();
    });
  } finally {
    child?.kill();
    await rm(cwd, { recursive: true, force: true });
  }
}
