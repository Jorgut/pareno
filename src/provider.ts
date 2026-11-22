import { Platform, requestUrl } from 'obsidian';
import { OLLAMA_CLOUD_ENDPOINT, parseAgentOutput, planRequest, renderPrompt } from './request-plan';
import type { ProviderSettings } from './request-plan';
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
  if (!Platform.isDesktopApp) {
    throw new Error('本机 Agent 只能在桌面版使用；手机端请选择 Ollama 云端或兼容 API。');
  }
  // Loaded lazily: the module imports Node built-ins, which mobile Obsidian lacks.
  const { runCli } = await import('./cli-transport');
  const output = await runCli(plan, renderPrompt(messages), cancelled);
  return parseAgentOutput(settings.provider as AgentKind, output);
}
