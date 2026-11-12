export type OllamaState = 'unknown' | 'running' | 'stopped' | 'missing' | 'error';

export interface OllamaStatus {
  state: OllamaState;
  models: string[];
  cloudModels: string[];
  cloudError: string;
  message: string;
  checkedAt: number;
}

export const OLLAMA_CLOUD_TAGS_URL = 'https://ollama.com/api/tags';
export const OLLAMA_CLOUD_KEYS_URL = 'https://ollama.com/settings/keys';

export const DEFAULT_OLLAMA_STATUS: OllamaStatus = {
  state: 'unknown',
  models: [],
  cloudModels: [],
  cloudError: '',
  message: '',
  checkedAt: 0
};

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

export function parseOllamaCloudModels(payload: unknown): string[] {
  return [...new Set(parseOllamaModels(payload).map(normalizeOllamaModel))];
}

export function normalizeOllamaModel(name: string): string {
  return name.trim().replace(/:latest$/i, '');
}

export function hasOllamaModel(models: string[], selected: string): boolean {
  if (!selected.trim()) return false;
  const target = normalizeOllamaModel(selected);
  return models.some(model => normalizeOllamaModel(model) === target);
}

export function hasOllamaCloudModel(status: OllamaStatus, selected: string): boolean {
  return hasOllamaModel(status.cloudModels, selected);
}

export function ollamaStatusLabel(status: OllamaStatus, selected: string, cloud = false): string {
  if (status.state === 'running') {
    if (cloud) {
      if (!status.cloudModels.length) {
        return status.cloudError ? `Ollama 已连接；云端目录读取失败：${status.cloudError}` : 'Ollama 已连接；正在读取云端模型目录…';
      }
      if (selected && !hasOllamaCloudModel(status, selected)) return `Ollama 云端目录里没有 ${selected}`;
      return `Ollama 已连接 · 云端目录 ${status.cloudModels.length} 个模型`;
    }
    const localPart = status.models.length ? `${status.models.length} 个本机模型` : '还没有安装本机模型';
    const cloudPart = status.cloudModels.length
      ? `云端目录 ${status.cloudModels.length} 个`
      : status.cloudError ? '云端目录不可用' : '正在读取云端目录';
    if (!status.models.length) return `Ollama 已连接，但还没有安装模型 · ${cloudPart}`;
    if (selected && !hasOllamaModel(status.models, selected)) return `Ollama 已连接；模型 ${selected} 尚未安装`;
    return `Ollama 已连接 · ${localPart} · ${cloudPart}`;
  }
  if (status.state === 'stopped') return status.message || 'Ollama 未启动';
  if (status.state === 'missing') return '未找到 Ollama 安装';
  if (status.state === 'error') return status.message || 'Ollama 连接异常';
  return '正在检查 Ollama…';
}
