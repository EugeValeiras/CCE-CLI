import assert from 'node:assert/strict';
import http from 'node:http';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { registerAlarmCommand } from '../src/commands/alarm.js';
import { runCli } from './support/run-cli.js';

/**
 * CCE#122 — `cce alarm test-mode`.
 *
 * El modo prueba deja la alarma de una casa real MUDA y es un toggle manual
 * que no vence solo, así que lo que se fija acá no es sólo que el toggle
 * escriba: es que el CLI lo DIGA. `status` y `arm` no pueden reportar "armada"
 * a secas mientras el disparo está degradado — el CLI es la vía rápida para
 * prender la prueba y va a ser también la vía por la que alguien descubra que
 * quedó prendida.
 *
 * Doble HTTP mínimo en 127.0.0.1: ninguna de estas escrituras puede salir a la
 * API real.
 */

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

class FakeAlarmApi {
  armed = false;
  testMode = false;
  /** El TIPO de alarma (CCE#133). `null` = backend viejo: no lo conoce. */
  mode: 'perimeter' | 'total' | null = 'total';
  /** El PUT del tipo contesta 200 SIN `mode`. */
  omitModeResponse = false;
  /** El PUT del tipo revienta. */
  failModePut = false;
  /** El backend contesta 200 con OTRO valor del que se pidió. */
  forceEnabledResponse: boolean | null = null;
  /** El backend contesta 200 sin el campo `enabled`. */
  omitEnabledResponse = false;
  /** El PUT del modo prueba revienta. */
  failTestModePut = false;
  readonly calls: Call[] = [];

  listen(): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const path = new URL(req.url ?? '', 'http://x').pathname;
        const method = req.method ?? 'GET';
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
        this.calls.push({ method, path, body });

        const reply = (status: number, payload: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };

        if (path === '/api/config/alarm-armed' && method === 'GET') {
          return reply(200, {
            armed: this.armed,
            ...(this.mode ? { mode: this.mode } : {}),
            testMode: this.testMode,
          });
        }
        if (path === '/api/config/alarm-armed' && method === 'PUT') {
          const b = body as { armed: boolean; mode?: 'perimeter' | 'total' };
          this.armed = b.armed;
          // Igual que la API: `mode` es OPCIONAL y sin él se arma el elegido.
          if (b.mode && this.mode !== null) this.mode = b.mode;
          return reply(200, {
            success: true,
            armed: this.armed,
            ...(this.mode ? { mode: this.mode } : {}),
          });
        }
        if (path === '/api/config/alarm-mode' && method === 'PUT') {
          if (this.failModePut) return reply(500, { message: 'boom', statusCode: 500 });
          const m = (body as { mode?: unknown } | undefined)?.mode;
          if (m !== 'perimeter' && m !== 'total') {
            return reply(400, { message: 'mode must be one of the following values', statusCode: 400 });
          }
          this.mode = m;
          if (this.omitModeResponse) return reply(200, { success: true });
          return reply(200, { success: true, mode: this.mode });
        }
        if (path === '/api/config/alarm-test-mode' && method === 'GET') {
          return reply(200, { enabled: this.testMode });
        }
        if (path === '/api/config/alarm-test-mode' && method === 'PUT') {
          if (this.failTestModePut) {
            return reply(500, { message: 'boom', statusCode: 500 });
          }
          // Igual que el DTO de la API: `enabled` booleano o 400.
          const enabled = (body as { enabled?: unknown } | undefined)?.enabled;
          if (typeof enabled !== 'boolean') {
            return reply(400, { message: 'enabled must be a boolean value', statusCode: 400 });
          }
          this.testMode = this.forceEnabledResponse ?? enabled;
          if (this.omitEnabledResponse) return reply(200, { success: true });
          return reply(200, { success: true, enabled: this.testMode });
        }
        reply(404, { message: 'Not found', statusCode: 404 });
      });
    });

    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no arrancó el doble');
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise<void>((done) => server.close(() => done())),
        });
      });
    });
  }
}

let api: FakeAlarmApi;
let close: () => Promise<void>;

before(() => {
  process.env.CCE_API_TOKEN = 'token-de-test';
  process.env.CCE_FORMAT = 'json';
});

after(() => {
  delete process.env.CCE_FORMAT;
});

beforeEach(async () => {
  api = new FakeAlarmApi();
  const started = await api.listen();
  close = started.close;
  process.env.CCE_API_URL = started.url;
});

afterEach(async () => {
  await close();
  process.exitCode = 0;
});

const run = (...argv: string[]) => runCli(registerAlarmCommand, argv);
const puts = () => api.calls.filter((c) => c.method === 'PUT');

// ── test-mode: prender y apagar ───────────────────────────────────────────

test('test-mode on manda `enabled: true` y avisa que la alarma no va a sonar', async () => {
  api.armed = true;

  const { out, exitCode } = await run('alarm', 'test-mode', 'on');

  assert.equal(exitCode, 0);
  assert.deepEqual(puts(), [
    { method: 'PUT', path: '/api/config/alarm-test-mode', body: { enabled: true } },
  ]);
  assert.match(out, /MODO PRUEBA ACTIVO/);
  assert.match(out, /NO va a sonar/);
  assert.match(out, /test-mode off/);
  assert.equal(api.testMode, true);
});

test('test-mode off apaga y dice que la alarma vuelve a sonar', async () => {
  api.armed = true;
  api.testMode = true;

  const { out, exitCode } = await run('alarm', 'test-mode', 'off');

  assert.equal(exitCode, 0);
  assert.deepEqual(puts(), [
    { method: 'PUT', path: '/api/config/alarm-test-mode', body: { enabled: false } },
  ]);
  assert.match(out, /vuelve a sonar/);
  assert.doesNotMatch(out, /MODO PRUEBA ACTIVO/);
  assert.equal(api.testMode, false);
});

test('test-mode sin argumento sólo lee: no escribe nada', async () => {
  api.armed = true;
  api.testMode = true;

  const { out, exitCode } = await run('alarm', 'test-mode');

  assert.equal(exitCode, 0);
  assert.equal(puts().length, 0);
  assert.match(out, /"enabled": true/);
  assert.match(out, /MODO PRUEBA ACTIVO/);
});

test('test-mode apagado: el estado se imprime y no hay aviso que asuste', async () => {
  const { out } = await run('alarm', 'test-mode');

  assert.match(out, /"enabled": false/);
  assert.doesNotMatch(out, /MODO PRUEBA ACTIVO/);
});

// ── el backend manda, no lo que se pidió ──────────────────────────────────

test('el estado que queda es el que confirmó el backend, no el que se pidió', async () => {
  // El backend acepta el PUT pero deja el modo APAGADO (un config que no
  // guardó, un middleware, lo que sea): el CLI no puede decir "activado".
  api.forceEnabledResponse = false;

  const { out, exitCode } = await run('alarm', 'test-mode', 'on');

  assert.equal(exitCode, 0);
  assert.doesNotMatch(out, /MODO PRUEBA ACTIVO/);
  assert.match(out, /desactivado/i);
});

test('una respuesta sin `enabled` no confirma nada: sale con error', async () => {
  api.omitEnabledResponse = true;

  const { out, exitCode } = await run('alarm', 'test-mode', 'on');

  assert.equal(exitCode, 1);
  assert.match(out, /no confirmó/i);
  assert.doesNotMatch(out, /Modo prueba ACTIVADO/);
});

test('si el PUT falla, sale con exitCode y no con process.exit', async () => {
  api.failTestModePut = true;

  const { out, exitCode } = await run('alarm', 'test-mode', 'on');

  assert.equal(exitCode, 1);
  assert.match(out, /HTTP 500/);
});

// ── con la alarma DESARMADA el aviso no grita ─────────────────────────────

test('desarmada, el aviso del modo prueba baja el tono', async () => {
  api.testMode = true;

  const { out } = await run('alarm', 'test-mode');

  assert.match(out, /Modo prueba activo/);
  assert.match(out, /desarmada/i);
  assert.doesNotMatch(out, /NO va a sonar/,
    'gritar sobre una alarma que no iba a sonar igual convierte el aviso en rutina');
});

test('desarmada, apagar el modo prueba no promete que "vuelve a sonar"', async () => {
  api.testMode = true;

  const { out } = await run('alarm', 'test-mode', 'off');

  assert.match(out, /Modo prueba desactivado/);
  assert.doesNotMatch(out, /vuelve a sonar/);
});

test('desarmada, status tampoco grita', async () => {
  api.testMode = true;

  const { out } = await run('alarm', 'status');

  assert.match(out, /Modo prueba activo/);
  assert.doesNotMatch(out, /NO va a sonar/);
});

test('un estado que no se entiende NO se manda: `on`/`off` y nada más', async () => {
  const { out, exitCode } = await run('alarm', 'test-mode', 'onn');

  assert.equal(exitCode, 1);
  assert.equal(api.calls.length, 0);
  assert.match(out, /Estado desconocido: "onn"/);
});

test('`ON` en mayúsculas es `on`: el typo que se corta es el otro', async () => {
  const { exitCode } = await run('alarm', 'test-mode', 'ON');

  assert.equal(exitCode, 0);
  assert.equal(api.testMode, true);
});

// ── que se VEA: la defensa contra olvidarlo prendido ──────────────────────

test('status con el modo prueba activo lo declara, no dice "armada" a secas', async () => {
  api.armed = true;
  api.testMode = true;

  const { out } = await run('alarm', 'status');

  assert.match(out, /"armed": true/);
  assert.match(out, /"testMode": true/);
  assert.match(out, /MODO PRUEBA ACTIVO/);
});

test('status sin modo prueba no inventa el aviso', async () => {
  api.armed = true;

  const { out } = await run('alarm', 'status');

  assert.match(out, /"armed": true/);
  assert.doesNotMatch(out, /MODO PRUEBA ACTIVO/);
});

test('arm con el modo prueba activo avisa que la alarma queda muda', async () => {
  api.testMode = true;

  const { out, exitCode } = await run('alarm', 'arm');

  assert.equal(exitCode, 0);
  assert.equal(api.armed, true);
  assert.match(out, /Alarma armada/);
  assert.match(out, /MODO PRUEBA ACTIVO/);
});

test('arm sin modo prueba se comporta exactamente como antes', async () => {
  const { out } = await run('alarm', 'arm');

  assert.equal(api.armed, true);
  assert.match(out, /Alarma armada/);
  assert.doesNotMatch(out, /MODO PRUEBA/);
});

test('disarm no se mete con el modo prueba: son cosas distintas', async () => {
  api.armed = true;
  api.testMode = true;

  await run('alarm', 'disarm');

  assert.equal(api.armed, false);
  assert.equal(api.testMode, true);
  assert.deepEqual(puts(), [
    { method: 'PUT', path: '/api/config/alarm-armed', body: { armed: false } },
  ]);
});

// ── CCE#133: el TIPO de alarma ────────────────────────────────────────────
//
// La alarma era un booleano y por eso casi no se usaba. Ahora se arma
// perimetral o total, y el CLI es la vía más rápida para las dos cosas — y
// también la vía por la que alguien puede armar el tipo equivocado sin darse
// cuenta. Lo que se fija acá es que el CLI lo DIGA, y que `cce alarm arm` a
// secas siga significando exactamente lo mismo que antes.

test('arm SIN tipo no manda `mode`: arma el elegido, como Siri y las escenas', async () => {
  api.mode = 'perimeter';

  const { out, exitCode } = await run('alarm', 'arm');

  assert.equal(exitCode, 0);
  assert.deepEqual(puts(), [
    { method: 'PUT', path: '/api/config/alarm-armed', body: { armed: true } },
  ]);
  assert.equal(api.armed, true);
  assert.equal(api.mode, 'perimeter', 'armar sin tipo no puede cambiar el elegido');
  assert.match(out, /Alarma armada — PERIMETRAL/);
});

test('arm perimetral arma en perimetral y lo deja elegido', async () => {
  api.mode = 'total';

  const { out, exitCode } = await run('alarm', 'arm', 'perimetral');

  assert.equal(exitCode, 0);
  assert.deepEqual(puts(), [
    {
      method: 'PUT',
      path: '/api/config/alarm-armed',
      body: { armed: true, mode: 'perimeter' },
    },
  ]);
  assert.equal(api.armed, true);
  assert.equal(api.mode, 'perimeter');
  assert.match(out, /Alarma armada — PERIMETRAL/);
});

test('arm total también, y acepta el literal del contrato', async () => {
  api.mode = 'perimeter';

  await run('alarm', 'arm', 'total');
  assert.equal(api.mode, 'total');

  api.calls.length = 0;
  await run('alarm', 'arm', 'perimeter');
  assert.deepEqual(puts(), [
    {
      method: 'PUT',
      path: '/api/config/alarm-armed',
      body: { armed: true, mode: 'perimeter' },
    },
  ]);
});

test('un tipo que no se entiende NO se manda', async () => {
  api.mode = 'total';

  const { out, exitCode } = await run('alarm', 'arm', 'perimetal');

  assert.equal(exitCode, 1);
  assert.deepEqual(puts(), [], 'adivinar acá es armar la casa protegiendo otra cosa');
  assert.equal(api.armed, false, 'y sobre todo: NO se armó');
  assert.match(out, /Tipo desconocido/);
  assert.match(out, /perimetral/);
});

test('status dice el tipo, no sólo si está armada', async () => {
  api.armed = true;
  api.mode = 'perimeter';

  const { out } = await run('alarm', 'status');

  assert.match(out, /"mode": "perimeter"/, 'el JSON lo trae para scripts');
  assert.match(out, /Alarma PERIMETRAL/);
  assert.match(out, /puertas y accesos/, '«perimetral» no significa nada por sí solo');
});

test('status desarmada dice cuál se va a armar, sin gritar', async () => {
  api.armed = false;
  api.mode = 'total';

  const { out } = await run('alarm', 'status');

  assert.match(out, /Tipo elegido: TOTAL/);
  assert.doesNotMatch(out, /Alarma TOTAL: protege/, 'desarmada no protege nada todavía');
});

test('contra una API vieja, status no inventa un tipo', async () => {
  api.armed = true;
  api.mode = null; // backend sin CCE#133

  const { out, exitCode } = await run('alarm', 'status');

  assert.equal(exitCode, 0);
  assert.doesNotMatch(out, /PERIMETRAL|TOTAL/, 'sin `mode` no hay tipo que declarar');
  assert.match(out, /"armed": true/, 'y el resto se sigue leyendo igual');
});

test('arm contra una API vieja dice "Alarma armada" a secas', async () => {
  api.mode = null;

  const { out, exitCode } = await run('alarm', 'arm');

  assert.equal(exitCode, 0);
  assert.match(out, /Alarma armada/);
  assert.doesNotMatch(out, /—\s*(PERIMETRAL|TOTAL)/);
});

test('mode sin argumento muestra el elegido y no escribe nada', async () => {
  api.armed = false;
  api.mode = 'perimeter';

  const { out, exitCode } = await run('alarm', 'mode');

  assert.equal(exitCode, 0);
  assert.deepEqual(puts(), [], 'leer no escribe');
  assert.match(out, /"mode": "perimeter"/);
  assert.match(out, /Tipo elegido: PERIMETRAL/);
});

test('mode total cambia el tipo SIN armar ni desarmar', async () => {
  api.armed = true;
  api.mode = 'perimeter';

  const { out, exitCode } = await run('alarm', 'mode', 'total');

  assert.equal(exitCode, 0);
  assert.deepEqual(puts(), [
    { method: 'PUT', path: '/api/config/alarm-mode', body: { mode: 'total' } },
  ]);
  assert.equal(api.mode, 'total');
  assert.equal(api.armed, true, 'cambiar el tipo no desarma la casa');
  assert.match(out, /Tipo de alarma: TOTAL/);
  assert.match(out, /sigue ARMADA y ahora protege/);
});

test('mode con la alarma desarmada no promete que ya protege', async () => {
  api.armed = false;
  api.mode = 'total';

  const { out } = await run('alarm', 'mode', 'perimetral');

  assert.equal(api.armed, false);
  assert.match(out, /sigue desarmada/);
  assert.doesNotMatch(out, /sigue ARMADA/);
});

test('mode con un tipo que no se entiende no manda nada', async () => {
  api.mode = 'total';

  const { out, exitCode } = await run('alarm', 'mode', 'parcial');

  assert.equal(exitCode, 1);
  assert.deepEqual(puts(), []);
  assert.equal(api.mode, 'total');
  assert.match(out, /Tipo desconocido/);
});

test('una respuesta sin `mode` no confirma nada: sale con error', async () => {
  api.armed = true;
  api.mode = 'total';
  api.omitModeResponse = true;

  const { out, exitCode } = await run('alarm', 'mode', 'perimetral');

  assert.equal(exitCode, 1);
  assert.match(out, /no confirmó el tipo/);
});

test('si el PUT del tipo falla, sale con exitCode y no con process.exit', async () => {
  api.failModePut = true;

  const { exitCode } = await run('alarm', 'mode', 'perimetral');

  assert.equal(exitCode, 1);
});

test('mode contra una API vieja lo dice en vez de mostrar la nada', async () => {
  api.mode = null;

  const { out, exitCode } = await run('alarm', 'mode');

  assert.equal(exitCode, 1);
  assert.match(out, /no conoce los tipos de alarma/);
});

test('el tipo y el modo prueba conviven: los DOS avisos salen', async () => {
  // El riesgo que el issue nombra por su nombre: ahora hay dos cosas que se
  // llaman «modo». Si alguien cree que armó en total y estaba en modo prueba,
  // la alarma no suena — los dos hechos tienen que estar a la vista.
  api.armed = true;
  api.mode = 'perimeter';
  api.testMode = true;

  const { out } = await run('alarm', 'status');

  assert.match(out, /Alarma PERIMETRAL/);
  assert.match(out, /MODO PRUEBA ACTIVO/);
});

test('disarm no se mete con el tipo: queda elegido para la próxima', async () => {
  api.armed = true;
  api.mode = 'perimeter';

  const { exitCode } = await run('alarm', 'disarm');

  assert.equal(exitCode, 0);
  assert.deepEqual(puts(), [
    { method: 'PUT', path: '/api/config/alarm-armed', body: { armed: false } },
  ]);
  assert.equal(api.mode, 'perimeter');
});
