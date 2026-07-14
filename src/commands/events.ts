import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createSocket } from '../lib/socket-client.js';
import { createApiClient } from '../lib/api-client.js';
import { Column, OutputFormat, fail, info, printRows, warn } from '../lib/format.js';
import { resolveFormat } from '../lib/user-config.js';
import {
  AutomationExecutedBroadcast,
  DeviceStateChangedBroadcast,
  EventRecord,
  EventsListResponse,
  LightBroadcast,
} from '../types/api.js';

interface GlobalOpts {
  apiUrl?: string;
  format?: OutputFormat;
}

function getGlobals(cmd: Command): GlobalOpts {
  const opts = cmd.optsWithGlobals<GlobalOpts>();
  return { apiUrl: opts.apiUrl, format: opts.format };
}

const EVENTS = [
  'light:changed',
  'device:state-changed',
  'automation:executed',
  'alarm:armed-changed',
  'alarm:triggered',
] as const;

export function registerEventsCommand(program: Command): void {
  const cmd = program.command('events').description('Observar eventos en tiempo real (Socket.IO)');

  cmd
    .command('live')
    .description('Suscribirse al stream de eventos del CCE')
    .option('--device <id>', 'Filtrar por deviceId o lightId')
    .option('--event <name...>', `Solo estos eventos: ${EVENTS.join(', ')}`)
    .option('--json', 'Imprimir eventos raw como JSON')
    .action((opts: { device?: string; event?: string[]; json?: boolean }) => {
      const g = getGlobals(cmd);
      const socket = createSocket(g.apiUrl);
      const eventFilter = new Set(opts.event ?? EVENTS);

      socket.on('connect', () => {
        info(`Conectado (id=${socket.id}). Escuchando: ${Array.from(eventFilter).join(', ')}`);
      });
      socket.on('connect_error', (err) => {
        fail(`Socket error: ${err.message}`);
      });
      socket.on('disconnect', (reason) => {
        info(`Desconectado: ${reason}`);
      });

      for (const ev of EVENTS) {
        if (!eventFilter.has(ev)) continue;
        socket.on(ev, (payload: unknown) => {
          if (opts.device && !matchesDevice(ev, payload, opts.device)) return;
          if (opts.json) {
            console.log(JSON.stringify({ event: ev, payload }));
          } else {
            console.log(format(ev, payload));
          }
        });
      }

      process.on('SIGINT', () => {
        socket.close();
        process.exit(0);
      });
    });

  cmd
    .command('list')
    .description('Consultar el histórico de eventos persistido (GET /api/events)')
    .option('--limit <n>', 'Máximo de eventos a traer (1-1000)', parseLimit, 100)
    .option('--channel <channel>', 'Filtrar por canal: internal | websocket')
    .option('--event <name>', 'Filtrar por nombre de evento (ej: device.state.changed)')
    .option('--device <id>', 'Filtrar por globalId del dispositivo')
    .option('--provider <provider>', 'Filtrar por provider (ej: hue, tuya, matter)')
    .option('--from <iso>', 'Desde (ISO 8601, ej: 2026-06-18T00:00:00Z)')
    .option('--to <iso>', 'Hasta (ISO 8601)')
    .option('--cursor <cursor>', 'Cursor de paginación (nextCursor de una consulta previa)')
    .option('--all', 'Seguir el cursor y traer todas las páginas')
    .action(async (opts: ListOpts) => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });

      if (opts.channel && opts.channel !== 'internal' && opts.channel !== 'websocket') {
        fail(`--channel inválido: ${opts.channel} (usá internal | websocket)`);
        process.exit(1);
      }

      const baseParams: Record<string, string | number> = { limit: opts.limit };
      if (opts.channel) baseParams.channel = opts.channel;
      if (opts.event) baseParams.eventName = opts.event;
      if (opts.device) baseParams.globalId = opts.device;
      if (opts.provider) baseParams.provider = opts.provider;
      if (opts.from) baseParams.from = opts.from;
      if (opts.to) baseParams.to = opts.to;

      const spinner = ora('Consultando eventos...').start();
      try {
        const items: EventRecord[] = [];
        let cursor = opts.cursor;
        let enabled = true;
        do {
          const params = { ...baseParams, ...(cursor ? { cursor } : {}) };
          const { data } = await client.get<EventsListResponse>('/events', { params });
          enabled = data.enabled;
          items.push(...data.items);
          cursor = data.nextCursor ?? undefined;
        } while (opts.all && cursor && items.length < HARD_CAP);
        spinner.stop();

        if (!enabled) {
          warn('El events-store está deshabilitado en el backend (EVENTS_STORE_ENABLED=false).');
        }
        if (opts.all && cursor && items.length >= HARD_CAP) {
          warn(`Tope de seguridad alcanzado (${HARD_CAP}). Quedaron más eventos sin traer.`);
        }

        printRows(items, eventColumns, fmt);

        if (!opts.all && cursor && fmt === 'table') {
          info(`Hay más eventos. Próxima página: --cursor ${cursor}`);
        }
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });
}

const HARD_CAP = 10000;

interface ListOpts {
  limit: number;
  channel?: string;
  event?: string;
  device?: string;
  provider?: string;
  from?: string;
  to?: string;
  cursor?: string;
  all?: boolean;
}

function parseLimit(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    fail('--limit debe ser un entero entre 1 y 1000');
    process.exit(1);
  }
  return n;
}

const eventColumns: Column<EventRecord>[] = [
  { header: 'Time', get: (e) => new Date(e.time).toLocaleString() },
  { header: 'Channel', get: (e) => e.channel },
  { header: 'Event', get: (e) => e.eventName },
  { header: 'Source', get: (e) => e.source ?? '' },
  { header: 'Provider', get: (e) => e.provider ?? '' },
  { header: 'Device', get: (e) => e.globalId ?? '' },
  { header: 'Payload', get: (e) => summarizePayload(e.payload) },
];

function summarizePayload(payload: EventRecord['payload']): string {
  if (payload === null || payload === undefined) return '';
  const json = JSON.stringify(payload);
  return json.length > 80 ? `${json.slice(0, 77)}...` : json;
}

function matchesDevice(event: string, payload: unknown, id: string): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  if (event === 'light:changed') return (p as unknown as LightBroadcast).lightId === id;
  if (event === 'device:state-changed') return (p as unknown as DeviceStateChangedBroadcast).deviceId === id;
  if (event === 'automation:executed') return (p as unknown as AutomationExecutedBroadcast).automationId === id;
  return false;
}

function format(event: string, payload: unknown): string {
  const ts = new Date().toLocaleTimeString();
  const tag = chalk.gray(`[${ts}]`);
  const name = chalk.bold.magenta(event.padEnd(24));
  return `${tag} ${name} ${JSON.stringify(payload)}`;
}
