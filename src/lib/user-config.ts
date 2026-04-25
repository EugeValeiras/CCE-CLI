import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface UserConfig {
  apiUrl: string;
  outputFormat: 'table' | 'json' | 'csv';
  providers: {
    hue?: { bridgeIp: string; apiKey: string };
    tuya?: { accessId: string; accessSecret: string; region: string };
    ewelink?: { email: string; password: string; region: string };
  };
}

const DEFAULT_CONFIG: UserConfig = {
  apiUrl: 'http://localhost:3000',
  outputFormat: 'table',
  providers: {},
};

export function getConfigDir(): string {
  return path.join(os.homedir(), '.cce');
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function loadConfig(): UserConfig {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed, providers: { ...(parsed.providers ?? {}) } };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: UserConfig): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function resolveApiUrl(flagUrl?: string): string {
  return flagUrl ?? process.env.CCE_API_URL ?? loadConfig().apiUrl;
}

export function resolveFormat(flagFormat?: string): 'table' | 'json' | 'csv' {
  const fmt = (flagFormat ?? process.env.CCE_FORMAT ?? loadConfig().outputFormat) as UserConfig['outputFormat'];
  return (['table', 'json', 'csv'] as const).includes(fmt) ? fmt : 'table';
}
