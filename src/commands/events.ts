import { Command } from 'commander';
import chalk from 'chalk';
import { createSocket } from '../lib/socket-client.js';
import { fail, info } from '../lib/format.js';
import {
  AutomationExecutedBroadcast,
  DeviceStateChangedBroadcast,
  LightBroadcast,
} from '../types/api.js';

interface GlobalOpts {
  apiUrl?: string;
  format?: 'table' | 'json' | 'csv';
}

function getGlobals(cmd: Command): GlobalOpts {
  return cmd.optsWithGlobals<GlobalOpts>();
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
