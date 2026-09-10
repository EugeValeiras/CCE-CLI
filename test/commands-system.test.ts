import assert from 'node:assert/strict';
import http from 'node:http';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { bytes, explicarError, filasDeMuestra, registerSystemCommand, uptime } from '../src/commands/system.js';
import { ApiError } from '../src/lib/api-client.js';
import type { MetricsSample, SystemMetricsResponse } from '../src/types/api.js';
import { runCli } from './support/run-cli.js';

/**
 * EugeValeiras/CCE#174 — `cce system`.
 *
 * Lo que se fija: que la tabla diga lo que el despachante va a mirar después
 * de un deploy (CPU, temperatura, memoria, discos, I/O, red, el proceso), que
 * `--format json` devuelva el payload tal cual, y que contra una API vieja
 * (sin el endpoint) o sin token el CLI diga qué pasa en vez de un stack.
 *
 * `--watch` se suscribe por Socket.IO; el render que refresca es
 * `filasDeMuestra`, que se prueba acá a secas. El vivo contra un servidor
 * real queda fuera (el CLI no trae `socket.io` servidor).
 *
 * Doble HTTP mínimo en 127.0.0.1: nada de esto sale a la API real.
 */

const MB = 1024 * 1024;

/** Una muestra con los números de la Pi real (los fixtures del API). */
function muestraDeLaPi(): MetricsSample {
  return {
    sampledAt: Date.UTC(2026, 8, 10, 15, 0, 5),
    cpu: {
      usagePct: 1.0,
      perCore: [1.4, 0.8, 1.0, 1.2],
      load1: 0.52,
      load5: 0.48,
      load15: 0.45,
      tempC: 59.0,
      throttled: { raw: 0, active: [], occurred: [] },
    },
    mem: {
      totalBytes: 4079576 * 1024,
      usedBytes: (4079576 - 2281116) * 1024,
      availableBytes: 2281116 * 1024,
      swapTotalBytes: 2039784 * 1024,
      swapUsedBytes: 1613271040,
    },
    disk: [
      { mount: '/', device: '/dev/mmcblk0p2', totalBytes: 62248648704, usedBytes: 30331146240, availableBytes: 29332586496, usedPct: 50.8 },
      { mount: '/mnt/ssd', device: '/dev/nvme0n1p2', totalBytes: 234623012864, usedBytes: 17182396416, availableBytes: 205447868416, usedPct: 7.7 },
    ],
    io: [
      { device: 'nvme0n1', readBytesPerSec: 0, writeBytesPerSec: 16384, readOpsPerSec: 0, writeOpsPerSec: 2.2 },
      { device: 'mmcblk0', readBytesPerSec: 0, writeBytesPerSec: 150732.8, readOpsPerSec: 0, writeOpsPerSec: 16.8 },
    ],
    net: [
      { iface: 'eth0', rxBytesPerSec: 15527.6, txBytesPerSec: 34706 },
      { iface: 'tailscale0', rxBytesPerSec: 987.6, txBytesPerSec: 28516.8 },
    ],
    process: { rssBytes: 269 * MB, heapUsedBytes: 90 * MB, heapTotalBytes: 120 * MB, eventLoopLagMs: 12.3 },
    uptime: { hostSec: 610170, processSec: 4320 },
  };
}

function respuesta(over: Partial<SystemMetricsResponse> = {}): SystemMetricsResponse {
  const current = muestraDeLaPi();
  return {
    available: true,
    intervalMs: 5000,
    retainedMinutes: 60,
    host: { hostname: 'cce', cores: 4, arch: 'arm64', kernel: '6.8.0-1063-raspi', platform: 'linux' },
    current,
    history: [],
    ...over,
  };
}

class FakeSystemApi {
  status = 200;
  body: unknown = respuesta();
  readonly calls: { method: string; path: string; token?: string }[] = [];

  listen(): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      const path = new URL(req.url ?? '', 'http://x').pathname;
      this.calls.push({ method: req.method ?? 'GET', path, token: req.headers['x-cce-token'] as string | undefined });
      if (path !== '/api/system/metrics') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: `Cannot GET ${path}`, error: 'Not Found', statusCode: 404 }));
        return;
      }
      res.writeHead(this.status, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          this.status === 200
            ? this.body
            : this.status === 401
              ? { message: 'X-CCE-Token inválido o ausente', error: 'Unauthorized', statusCode: 401 }
              : { message: 'Cannot GET /api/system/metrics', error: 'Not Found', statusCode: 404 },
        ),
      );
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise((r) => server.close(() => r())),
        });
      });
    });
  }
}

let api: FakeSystemApi;
let close: () => Promise<void>;

before(() => {
  process.env.CCE_API_TOKEN = 'token-de-test';
});

after(() => {
  delete process.env.CCE_API_URL;
});

beforeEach(async () => {
  api = new FakeSystemApi();
  const started = await api.listen();
  close = started.close;
  process.env.CCE_API_URL = started.url;
});

afterEach(async () => {
  await close();
  process.exitCode = 0;
});

const run = (...argv: string[]) => runCli(registerSystemCommand, argv);
/** La salida sin los colores de chalk, para afirmar sobre el texto. */
const plano = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

// ── La tabla ──────────────────────────────────────────────────────────────────

test('cce system: una tabla con CPU, temperatura, memoria, discos, I/O, red y el proceso', async () => {
  const { out, exitCode } = await run('system');
  const texto = plano(out);

  assert.equal(exitCode, 0);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].path, '/api/system/metrics');
  assert.equal(api.calls[0].token, 'token-de-test', 'el GET lleva el token: el endpoint es siempre con token');

  assert.match(texto, /Host\s*│\s*cce\s*│\s*4 cores arm64 · 6\.8\.0-1063-raspi/);
  assert.match(texto, /CPU\s*│\s*1,0 %/);
  assert.match(texto, /carga 0,52 0,48 0,45/);
  assert.match(texto, /Temperatura\s*│\s*59,0 °C\s*│\s*sin throttling/);
  assert.match(texto, /Memoria\s*│\s*1,7 GB usados\s*│\s*2,2 GB disponibles de 3,9 GB \(MemAvailable\)/);
  assert.match(texto, /Swap\s*│\s*1,5 GB de 1,9 GB/);
  assert.match(texto, /Disco \/\s*│\s*51 %\s*│\s*27,3 GB libres de 58,0 GB \(\/dev\/mmcblk0p2\)/);
  assert.match(texto, /Disco \/mnt\/ssd\s*│\s*8 %/);
  assert.match(texto, /I\/O mmcblk0\s*│\s*↓ 0 B\/s\s+↑ 147 KB\/s\s*│\s*0,0 \/ 16,8 ops\/s/);
  assert.match(texto, /I\/O nvme0n1\s*│\s*↓ 0 B\/s\s+↑ 16 KB\/s/);
  assert.match(texto, /Red eth0\s*│\s*↓ 15 KB\/s\s+↑ 34 KB\/s/);
  assert.match(texto, /Red tailscale0/);
  assert.match(texto, /API \(proceso\)\s*│\s*269 MB RSS\s*│\s*heap 90 MB de 120 MB · event loop p99 12,3 ms/);
  assert.match(texto, /Uptime\s*│\s*host 7 d 1 h\s*│\s*API 1 h 12 m/);
  assert.match(texto, /una cada 5 s · 60 min en memoria/);
});

test('cce system --format json: el payload crudo, tal cual', async () => {
  const { out, exitCode } = await run('--format', 'json', 'system');
  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(out), respuesta());
});

test('el throttling activo se dice en rojo, con sus flags', async () => {
  const cur = muestraDeLaPi();
  cur.cpu.throttled = { raw: 0x50005, active: ['under-voltage', 'throttled'], occurred: ['under-voltage', 'throttled'] };
  api.body = respuesta({ current: cur });
  const { out } = await run('system');
  assert.match(plano(out), /AHORA: under-voltage, throttled/);
});

// ── Cuando no hay métricas ────────────────────────────────────────────────────

test('contra una API sin el endpoint (versión vieja): un mensaje claro, sin stack, exit 1', async () => {
  api.status = 404;
  const { out, exitCode } = await run('system');
  assert.equal(exitCode, 1);
  assert.match(out, /anterior a CCE#174/);
  assert.match(out, /GET \/api\/system\/metrics/);
  assert.doesNotMatch(out, /\n\s+at /, 'sin stack');
});

test('sin token válido: dice que hace falta CCE_API_TOKEN, exit 1', async () => {
  api.status = 401;
  const { out, exitCode } = await run('system');
  assert.equal(exitCode, 1);
  assert.match(out, /401/);
  assert.match(out, /CCE_API_TOKEN/);
});

test('con la API caída: el mensaje de transporte, exit 1', async () => {
  await close();
  close = async () => {};
  const { out, exitCode } = await run('system');
  assert.equal(exitCode, 1);
  assert.match(out, /Cannot reach CCE API/);
});

test('available: false (la API no corre en Linux): avisa y muestra igual el proceso', async () => {
  const cur = muestraDeLaPi();
  cur.mem = null;
  cur.disk = null;
  cur.io = null;
  cur.net = null;
  cur.cpu = { ...cur.cpu, usagePct: null, perCore: null, tempC: null, throttled: null };
  api.body = respuesta({
    available: false,
    current: cur,
    host: { hostname: 'mac', cores: 8, arch: 'arm64', kernel: '25.6.0', platform: 'darwin' },
  });
  const { out, exitCode } = await run('system');
  const texto = plano(out);
  assert.equal(exitCode, 0);
  assert.match(texto, /no corre en Linux/);
  assert.match(texto, /available: false/);
  assert.match(texto, /API \(proceso\)\s*│\s*269 MB RSS/);
  assert.match(texto, /CPU\s*│\s*—/);
  assert.match(texto, /Temperatura\s*│\s*—\s*│\s*throttling: sin dato/);
  assert.doesNotMatch(texto, /Disco/);
  assert.doesNotMatch(texto, /I\/O/);
});

test('sin ninguna muestra todavía (la API acaba de arrancar): lo dice, exit 0', async () => {
  api.body = respuesta({ current: null });
  const { out, exitCode } = await run('system');
  assert.equal(exitCode, 0);
  assert.match(out, /acaba de arrancar/);
  assert.doesNotMatch(plano(out), /│/);
});

// ── El render a secas, que es lo que refresca `--watch` ──────────────────────

test('filasDeMuestra: una fila por cosa, en el orden en que se leen', () => {
  const filas = filasDeMuestra(respuesta());
  assert.deepEqual(
    filas.map((f) => f.metrica),
    [
      'Host',
      'CPU',
      'Temperatura',
      'Memoria',
      'Swap',
      'Disco /',
      'Disco /mnt/ssd',
      'I/O nvme0n1',
      'I/O mmcblk0',
      'Red eth0',
      'Red tailscale0',
      'API (proceso)',
      'Uptime',
      'Muestra',
    ],
  );
  // Con `current` nuevo (lo que hace --watch con cada metrics:sample) la
  // tabla cambia con él.
  const otra = muestraDeLaPi();
  otra.cpu.usagePct = 42.5;
  const cpu = filasDeMuestra(respuesta({ current: otra })).find((f) => f.metrica === 'CPU')!;
  assert.match(plano(cpu.valor), /42,5 %/);
  assert.equal(filasDeMuestra(respuesta({ current: null })).length, 0);
});

test('los formatos: bytes con coma, uptime en d/h/m', () => {
  assert.equal(bytes(2281116 * 1024), '2,2 GB');
  assert.equal(bytes(269 * MB), '269 MB');
  assert.equal(bytes(16384), '16 KB');
  assert.equal(bytes(0), '0 B');
  assert.equal(uptime(610170), '7 d 1 h');
  assert.equal(uptime(4320), '1 h 12 m');
  assert.equal(uptime(300), '5 m');
});

test('explicarError: 404 y 401 tienen su frase, el resto pasa el mensaje', () => {
  assert.match(explicarError(new ApiError('HTTP 404: Not Found', 404)), /anterior a CCE#174/);
  assert.match(explicarError(new ApiError('HTTP 401: nope', 401)), /CCE_API_TOKEN/);
  assert.equal(explicarError(new ApiError('HTTP 500: boom', 500)), 'HTTP 500: boom');
  assert.equal(explicarError(new Error('otra cosa')), 'otra cosa');
});
