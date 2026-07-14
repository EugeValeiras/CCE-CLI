import { Command } from 'commander';
import { createApiClient } from '../lib/api-client.js';
import { fail, info, printObject, success } from '../lib/format.js';
import {
  getConfigPath,
  loadConfig,
  resolveFormat,
  saveConfig,
  UserConfig,
} from '../lib/user-config.js';

interface GlobalOpts {
  apiUrl?: string;
  format?: 'table' | 'json' | 'csv';
}

function getGlobals(cmd: Command): GlobalOpts {
  return cmd.optsWithGlobals<GlobalOpts>();
}

export function registerConfigCommand(program: Command): void {
  const cmd = program.command('config').description('Configuración local y remota del CCE');

  cmd
    .command('path')
    .description('Mostrar ruta del archivo de config local')
    .action(() => {
      console.log(getConfigPath());
    });

  cmd
    .command('local')
    .description('Mostrar configuración local (~/.cce/config.json)')
    .action(() => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      printObject(maskToken(loadConfig()), fmt === 'table' ? 'json' : fmt);
    });

  cmd
    .command('set <keyPath> <value>')
    .description('Setear una key local con dot.notation (ej: providers.hue.bridgeIp 192.168.0.x)')
    .action((keyPath: string, value: string) => {
      const cfg = loadConfig();
      setDeep(cfg as unknown as Record<string, unknown>, keyPath, parseValue(value));
      saveConfig(cfg);
      success(`Guardado ${keyPath}`);
    });

  cmd
    .command('unset <keyPath>')
    .description('Eliminar una key local')
    .action((keyPath: string) => {
      const cfg = loadConfig();
      unsetDeep(cfg as unknown as Record<string, unknown>, keyPath);
      saveConfig(cfg);
      success(`Borrado ${keyPath}`);
    });

  cmd
    .command('show [section]')
    .description('Mostrar config remota del backend. Secciones: hue, tuya, ewelink, automations, groups, scenes, ...')
    .action(async (section?: string) => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      try {
        const url = section ? `/config/${section}` : '/config';
        const { data } = await client.get(url);
        printObject(data, fmt === 'table' ? 'json' : fmt);
      } catch (e) {
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('set-remote <section>')
    .description('Setear sección de la config remota desde stdin JSON')
    .action(async (section: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      try {
        const raw = await readStdin();
        const body = JSON.parse(raw);
        await client.put(`/config/${section}`, body);
        success(`Config remota /${section} actualizada.`);
      } catch (e) {
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('init')
    .description('Crear config local con defaults si no existe')
    .action(() => {
      const cfg = loadConfig();
      saveConfig(cfg as UserConfig);
      info(`Config en ${getConfigPath()}`);
      printObject(maskToken(cfg), 'json');
    });
}

function maskToken(cfg: UserConfig): UserConfig {
  if (!cfg.apiToken) return cfg;
  return { ...cfg, apiToken: `${cfg.apiToken.slice(0, 4)}…` };
}

function parseValue(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  try {
    if (v.startsWith('{') || v.startsWith('[')) return JSON.parse(v);
  } catch {
    /* fall through */
  }
  return v;
}

function setDeep(obj: Record<string, unknown>, keyPath: string, value: unknown): void {
  const keys = keyPath.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

function unsetDeep(obj: Record<string, unknown>, keyPath: string): void {
  const keys = keyPath.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof cur[k] !== 'object' || cur[k] === null) return;
    cur = cur[k] as Record<string, unknown>;
  }
  delete cur[keys[keys.length - 1]];
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      reject(new Error('Pasá el JSON por stdin (ej: echo \'{...}\' | cce config set-remote hue)'));
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}
