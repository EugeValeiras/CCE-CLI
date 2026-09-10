import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { createApiClient, isApiError, isTransportError } from '../lib/api-client.js';
import { createSocket } from '../lib/socket-client.js';
import { Column, OutputFormat, fail, info, printRows, warn } from '../lib/format.js';
import { resolveFormat } from '../lib/user-config.js';
import type { MetricsSample, SystemMetricsResponse } from '../types/api.js';

interface GlobalOpts {
  apiUrl?: string;
  format?: OutputFormat;
}

function getGlobals(cmd: Command): GlobalOpts {
  const opts = cmd.optsWithGlobals<GlobalOpts>();
  return { apiUrl: opts.apiUrl, format: opts.format };
}

/** Una fila de la tabla de `cce system`. */
export interface Fila {
  metrica: string;
  valor: string;
  detalle: string;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

/**
 * `cce system` (EugeValeiras/CCE#174): cómo está la Pi ahora, en una tabla.
 * Es lo que mira el despachante después de un deploy sin abrir la consola
 * web. `--format json` devuelve el payload crudo de `GET /api/system/metrics`;
 * `--watch` se suscribe a `metrics:sample` y refresca la tabla con cada
 * muestra (una cada 5 s), y sale limpio con Ctrl-C.
 */
export function registerSystemCommand(program: Command): void {
  program
    .command('system')
    .description('Métricas de la Pi: CPU, temperatura, memoria, disco, I/O, red y el proceso de la API')
    .option('--watch', 'Seguir en vivo: refresca con cada muestra (Ctrl-C para salir)')
    .action(async (opts: { watch?: boolean }, cmd: Command) => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });

      const spinner = fmt === 'table' ? ora('Leyendo las métricas del host...').start() : null;
      let r: SystemMetricsResponse;
      try {
        const res = await client.get<SystemMetricsResponse>('/system/metrics');
        r = res.data;
      } catch (e) {
        spinner?.stop();
        fail(explicarError(e));
        process.exitCode = 1;
        return;
      }
      spinner?.stop();

      if (!opts.watch) {
        mostrar(r, fmt);
        return;
      }

      // En vivo. El alta a la sala lleva la misma auth estricta que el
      // endpoint: si el servidor la rechaza se dice y se sale, en vez de
      // quedarse esperando muestras que nunca van a llegar.
      const socket = createSocket(g.apiUrl);
      let ultima: SystemMetricsResponse = r;
      const pintar = () => {
        if (fmt === 'table') process.stdout.write('\x1b[2J\x1b[H');
        mostrar(ultima, fmt);
        if (fmt === 'table') info('En vivo: una muestra cada ' + ultima.intervalMs / 1000 + ' s. Ctrl-C para salir.');
      };
      pintar();

      socket.on('connect', () => {
        socket.emit('metrics:subscribe', (res: { ok: boolean; error?: string } | undefined) => {
          if (!res?.ok) {
            fail(
              res?.error === 'unauthorized'
                ? 'La API rechazó la suscripción al vivo: falta un X-CCE-Token válido (CCE_API_TOKEN).'
                : `La API no aceptó la suscripción al vivo (${res?.error ?? 'sin respuesta'}).`,
            );
            socket.close();
            process.exitCode = 1;
          }
        });
      });
      socket.on('connect_error', (err) => {
        fail(`Socket error: ${err.message}`);
      });
      socket.on('disconnect', (reason) => {
        if (fmt === 'table') warn(`Socket desconectado: ${reason}. Reintentando...`);
      });
      socket.on('metrics:sample', (sample: MetricsSample) => {
        ultima = { ...ultima, current: sample };
        if (fmt === 'table') pintar();
        else console.log(JSON.stringify(sample));
      });

      process.on('SIGINT', () => {
        socket.close();
        process.exit(0);
      });
    });
}

function mostrar(r: SystemMetricsResponse, fmt: OutputFormat): void {
  if (fmt === 'json') {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (!r.available) {
    warn('Esta API no corre en Linux: no hay métricas del host (available: false). Se muestra sólo el proceso.');
  }
  if (!r.current) {
    warn('La API acaba de arrancar: todavía no hay ninguna muestra. Probá de nuevo en unos segundos.');
    return;
  }
  printRows(filasDeMuestra(r), columnas, fmt);
}

const columnas: Column<Fila>[] = [
  { header: 'Métrica', get: (f) => f.metrica },
  { header: 'Valor', get: (f) => f.valor },
  { header: 'Detalle', get: (f) => f.detalle },
];

/**
 * La tabla, fila por fila, a partir de la respuesta. Pura, para los tests:
 * lo que cambia con `--watch` es `current`, y esta función es todo el render.
 */
export function filasDeMuestra(r: SystemMetricsResponse): Fila[] {
  const s = r.current;
  if (!s) return [];
  const filas: Fila[] = [];

  filas.push({
    metrica: 'Host',
    valor: r.host.hostname,
    detalle: `${r.host.cores} cores ${r.host.arch} · ${r.host.kernel}`,
  });

  const cpuValor = s.cpu.usagePct === null ? '—' : `${coma(s.cpu.usagePct, 1)} %`;
  const cores = s.cpu.perCore ? ` · cores ${s.cpu.perCore.map((c) => coma(c, 0)).join(' / ')}` : '';
  filas.push({
    metrica: 'CPU',
    valor: colorear(cpuValor, s.cpu.usagePct === null ? 'na' : nivel(s.cpu.usagePct, 70, 90)),
    detalle: `carga ${coma(s.cpu.load1, 2)} ${coma(s.cpu.load5, 2)} ${coma(s.cpu.load15, 2)}${cores}`,
  });

  const t = s.cpu.throttled;
  const throttled =
    t === null
      ? 'throttling: sin dato'
      : t.active.length > 0
        ? `AHORA: ${t.active.join(', ')}`
        : t.occurred.length > 0
          ? `desde el arranque hubo ${t.occurred.join(', ')}`
          : 'sin throttling';
  filas.push({
    metrica: 'Temperatura',
    valor: colorear(
      s.cpu.tempC === null ? '—' : `${coma(s.cpu.tempC, 1)} °C`,
      s.cpu.tempC === null ? 'na' : nivel(s.cpu.tempC, 65, 75),
    ),
    detalle: t && t.active.length > 0 ? chalk.red(throttled) : throttled,
  });

  if (s.mem) {
    const m = s.mem;
    filas.push({
      metrica: 'Memoria',
      valor: colorear(
        `${bytes(m.usedBytes)} usados`,
        m.availableBytes < 500 * MB ? 'bad' : m.availableBytes < GB ? 'warn' : 'ok',
      ),
      detalle: `${bytes(m.availableBytes)} disponibles de ${bytes(m.totalBytes)} (MemAvailable)`,
    });
    filas.push({
      metrica: 'Swap',
      valor: m.swapTotalBytes === 0 ? 'sin swap' : `${bytes(m.swapUsedBytes)} de ${bytes(m.swapTotalBytes)}`,
      detalle: '',
    });
  } else {
    filas.push({ metrica: 'Memoria', valor: '—', detalle: '' });
  }

  for (const d of s.disk ?? []) {
    filas.push({
      metrica: `Disco ${d.mount}`,
      valor: colorear(`${coma(d.usedPct, 0)} %`, nivel(d.usedPct, 70, 85)),
      detalle: `${bytes(d.availableBytes)} libres de ${bytes(d.totalBytes)} (${d.device})`,
    });
  }

  for (const d of s.io ?? []) {
    filas.push({
      metrica: `I/O ${d.device}`,
      valor: `↓ ${tasa(d.readBytesPerSec)}  ↑ ${tasa(d.writeBytesPerSec)}`,
      detalle: `${coma(d.readOpsPerSec, 1)} / ${coma(d.writeOpsPerSec, 1)} ops/s (lectura / escritura)`,
    });
  }

  for (const n of s.net ?? []) {
    filas.push({
      metrica: `Red ${n.iface}`,
      valor: `↓ ${tasa(n.rxBytesPerSec)}  ↑ ${tasa(n.txBytesPerSec)}`,
      detalle: '',
    });
  }

  filas.push({
    metrica: 'API (proceso)',
    valor: `${bytes(s.process.rssBytes)} RSS`,
    detalle:
      `heap ${bytes(s.process.heapUsedBytes)} de ${bytes(s.process.heapTotalBytes)} · ` +
      `event loop p99 ${colorear(`${coma(s.process.eventLoopLagMs, 1)} ms`, nivel(s.process.eventLoopLagMs, 50, 100))}`,
  });

  filas.push({
    metrica: 'Uptime',
    valor: `host ${uptime(s.uptime.hostSec)}`,
    detalle: `API ${uptime(s.uptime.processSec)}`,
  });

  filas.push({
    metrica: 'Muestra',
    valor: new Date(s.sampledAt).toLocaleString(),
    detalle: `una cada ${r.intervalMs / 1000} s · ${r.retainedMinutes} min en memoria`,
  });

  return filas;
}

/** Qué decirle al despachante cuando el GET falla, sin stack. */
export function explicarError(e: unknown): string {
  if (isApiError(e, 404)) {
    return 'Esta API no expone GET /api/system/metrics: es una versión anterior a CCE#174. Actualizá CCE-API.';
  }
  if (isApiError(e, 401)) {
    return 'La API rechazó el token (401): cce system necesita un X-CCE-Token válido. Configurá CCE_API_TOKEN.';
  }
  if (isTransportError(e) || e instanceof Error) return e.message;
  return String(e);
}

type Nivel = 'ok' | 'warn' | 'bad' | 'na';

function nivel(v: number, warnDesde: number, badDesde: number): Nivel {
  if (v > badDesde) return 'bad';
  if (v > warnDesde) return 'warn';
  return 'ok';
}

function colorear(texto: string, n: Nivel): string {
  if (n === 'bad') return chalk.red(texto);
  if (n === 'warn') return chalk.yellow(texto);
  if (n === 'ok') return chalk.green(texto);
  return texto;
}

/** `1,3 GB`, `512 MB`, `24 KB`. */
export function bytes(n: number): string {
  if (n >= GB) return `${coma(n / GB, 1)} GB`;
  if (n >= MB) return `${coma(n / MB, 0)} MB`;
  if (n >= 1024) return `${coma(n / 1024, 0)} KB`;
  return `${Math.round(n)} B`;
}

/** Igual que `bytes`, por segundo. */
export function tasa(n: number): string {
  return `${bytes(n)}/s`;
}

/** `7 d 1 h`, `1 h 12 m`, `5 m`. */
export function uptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} m`;
  return `${m} m`;
}

function coma(n: number, decimales: number): string {
  return n.toFixed(decimales).replace('.', ',');
}
