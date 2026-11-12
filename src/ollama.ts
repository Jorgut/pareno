export type OllamaState = 'unknown' | 'running' | 'stopped' | 'missing' | 'error';

export interface OllamaStatus {
  state: OllamaState;
  models: string[];
  message: string;
  checkedAt: number;
}

export const DEFAULT_OLLAMA_STATUS: OllamaStatus = { state: 'unknown', models: [], message: '', checkedAt: 0 };

export function parseOllamaModels(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const tags = record.models;
  if (Array.isArray(tags)) {
    return tags
      .map(item => item && typeof item === 'object' ? (item as Record<string, unknown>).name : '')
      .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
  }
  const data = record.data;
  if (Array.isArray(data)) {
    return data
      .map(item => item && typeof item === 'object' ? (item as Record<string, unknown>).id : '')
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
  }
  return [];
}

export function normalizeOllamaModel(name: string): string {
  return name.trim().replace(/:latest$/i, '');
}

export function hasOllamaModel(models: string[], selected: string): boolean {
  if (!selected.trim()) return false;
  const target = normalizeOllamaModel(selected);
  return models.some(model => normalizeOllamaModel(model) === target);
}

export function ollamaStatusLabel(status: OllamaStatus, selected: string): string {
  if (status.state === 'running') {
    if (!status.models.length) return 'Ollama 已连接，但还没有安装模型';
    if (selected && !hasOllamaModel(status.models, selected)) return `Ollama 已连接；模型 ${selected} 尚未安装`;
    return `Ollama 已连接 · ${status.models.length} 个模型`;
  }
  if (status.state === 'stopped') return status.message || 'Ollama 未启动';
  if (status.state === 'missing') return '未找到 Ollama 安装';
  if (status.state === 'error') return status.message || 'Ollama 连接异常';
  return '正在检查 Ollama…';
}
