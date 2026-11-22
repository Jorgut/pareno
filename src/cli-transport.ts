// Desktop-only CLI transport for local agent executables.
// Loaded lazily via dynamic import so the plugin still loads on mobile.
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { parseAgentOutput } from './request-plan';
import type { RequestPlan } from './request-plan';
import { resolveAgentCommand } from './agent-desktop';

export async function runCli(plan: Extract<RequestPlan, { transport: 'cli' }>, prompt: string, cancelled: () => boolean): Promise<string> {
  const command = resolveAgentCommand(plan.command);
  const cwd = await mkdtemp(join(tmpdir(), 'pareno-writing-'));
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    if (cancelled()) throw new Error('已停止本次请求。');
    return await new Promise<string>((resolve, reject) => {
      const args = plan.prompt === 'arg' ? [...plan.args, prompt] : plan.args;
      child = spawn(command, args, {
        cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: isAbsolute(command) ? [dirname(command), process.env.PATH || ''].join(delimiter) : process.env.PATH
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
