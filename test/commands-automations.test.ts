import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { registerAutomationsCommand } from '../src/commands/automations.js';
import { FakeCceApi, Stored, fullAutomation } from './support/fake-cce-api.js';
import { runCli } from './support/run-cli.js';

/**
 * CCE#107 — La capa de comandos: exit code y reporte.
 *
 * Los otros suites cubren la lib y el interceptor. Lo que ejercita éste es lo
 * que ve el operador: qué se imprime tras un abort a mitad de camino y con qué
 * código sale el proceso. Es la mitad del contrato del fail-fast — un reporte
 * que no se emite, o un exit 0 sobre un fallo, valen lo mismo que fallar en
 * silencio.
 *
 * Corre contra `FakeCceApi` montado como servidor HTTP: pasa por axios y por el
 * interceptor reales, y el doble valida como el ValidationPipe de la API.
 */

let api: FakeCceApi;
let close: () => Promise<void>;
let tmpDir = '';

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-cli-test-'));
  // Que ni la URL ni el token salgan del ~/.cce/config.json de quien corra esto.
  process.env.CCE_API_TOKEN = 'token-de-test';
  process.env.CCE_FORMAT = 'table';
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  api = new FakeCceApi();
  const started = await api.listen();
  close = started.close;
  process.env.CCE_API_URL = started.url;
});

afterEach(async () => {
  await close();
  // `process.exitCode` es global: sin esto, un test que verifica el exit 1
  // haría salir con 1 al runner entero.
  process.exitCode = 0;
});

const run = (...argv: string[]) => runCli(registerAutomationsCommand, argv);

function fileWith(contenido: unknown): string {
  const file = path.join(tmpDir, `auto-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(contenido));
  return file;
}

const seed = (...autos: Record<string, unknown>[]): void => {
  api.automations.push(...(autos as Stored[]));
};

// ── create ────────────────────────────────────────────────────────────────

test('create: alta exitosa → exit 0 y «Creadas»', async () => {
  const { out, exitCode } = await run(
    'automations',
    'create',
    '-f',
    fileWith(fullAutomation('auto_1')),
  );

  assert.equal(exitCode, 0);
  assert.match(out, /Creadas \(1\): auto_1/);
  assert.deepEqual(
    api.automations.map((a) => a.id),
    ['auto_1'],
  );
});

test('create: sobre un id existente → «Actualizadas», no «Creadas»', async () => {
  seed(fullAutomation('auto_1', { name: 'vieja' }));

  const { out, exitCode } = await run(
    'automations',
    'create',
    '-f',
    fileWith(fullAutomation('auto_1', { name: 'nueva' })),
  );

  assert.equal(exitCode, 0);
  assert.match(out, /Actualizadas \(1\): auto_1/);
  assert.doesNotMatch(out, /Creadas/);
  assert.equal(api.automations[0].name, 'nueva');
});

test('create: un PARCHE PARCIAL desde archivo se aplica (el POST lo rechaza, el PATCH no)', async () => {
  // El README promete que «lo que no mandás se conserva». Contra la API real
  // eso sólo es cierto si el upsert sobrevive al 400 del ValidationPipe.
  seed(fullAutomation('auto_1', { name: 'La de siempre', enabled: true }));

  const { out, exitCode } = await run(
    'automations',
    'create',
    '-f',
    fileWith({ id: 'auto_1', enabled: false }),
  );

  assert.equal(exitCode, 0, out);
  assert.match(out, /Actualizadas \(1\): auto_1/);
  assert.equal(api.automations[0].enabled, false);
  assert.equal(api.automations[0].name, 'La de siempre', 'el merge es top-level');
});

test('create: abort a mitad → exit 1, y el reporte entero se emite', async () => {
  const { out, exitCode } = await run(
    'automations',
    'create',
    '-f',
    fileWith([
      fullAutomation('auto_a'),
      { id: 'auto_b', name: '' }, // ni crea ni parchea
      fullAutomation('auto_c'),
    ]),
  );

  assert.equal(exitCode, 1);
  // Las cuatro partes del reporte, ninguna truncada por un process.exit().
  assert.match(out, /Creadas \(1\): auto_a/);
  assert.match(out, /Falló en auto_b: HTTP 400: .*name should not be empty/);
  assert.match(out, /Sin intentar \(1\): auto_c/);
  assert.match(out, /reintentá/);
  assert.deepEqual(
    api.automations.map((a) => a.id),
    ['auto_a'],
  );
});

test('create: si lo aplicado tenía id, el consejo dice que reaplicar es seguro', async () => {
  const { out } = await run(
    'automations',
    'create',
    '-f',
    fileWith([fullAutomation('auto_a'), { id: 'auto_b', name: '' }]),
  );

  assert.match(out, /lo ACTUALIZA en vez de duplicarlo/);
  assert.doesNotMatch(out, /NO reapliques/);
});

test('create: con un item SIN id aplicado, el consejo advierte que reaplicar DUPLICA', async () => {
  const { out } = await run(
    'automations',
    'create',
    '-f',
    fileWith([fullAutomation(), { id: 'auto_b', name: '' }]),
  );

  // El id que acuñó la API, mapeado a cómo lo nombraba el archivo: sin esto el
  // dueño no tiene con qué editar el archivo antes de reintentar.
  assert.match(out, /Con id generado por la API \(1\)/);
  assert.match(out, /«sin id» → auto_gen_0/);
  assert.match(out, /NO reapliques el archivo tal cual/);
  assert.match(out, /automatizaciones duplicadas sobre el mismo trigger/);
});

test('create: falla el primer item → dice que no quedó nada escrito', async () => {
  const { out, exitCode } = await run(
    'automations',
    'create',
    '-f',
    fileWith([{ id: 'auto_a', name: '' }]),
  );

  assert.equal(exitCode, 1);
  assert.match(out, /No quedó nada escrito/);
  assert.equal(api.automations.length, 0);
});

test('create: una automatización exportada avisa que el flujo editado NO se guarda', async () => {
  seed(fullAutomation('auto_1'));

  const { out, exitCode } = await run(
    'automations',
    'create',
    '-f',
    fileWith(
      fullAutomation('auto_1', {
        flowDerived: true,
        flow: [{ type: 'do', actions: [] }],
        when: [{ type: 'manual' }],
      }),
    ),
  );

  assert.equal(exitCode, 0);
  assert.match(out, /Actualizadas \(1\): auto_1/);
  // El ✓ solo sería un no-op silencioso: el flujo editado no viaja.
  assert.match(out, /flowDerived/);
  assert.match(out, /se quitaron "flow"\/"when" del envío/);
  const enviado = api.calls.at(-1)?.body as Record<string, unknown>;
  assert.equal(enviado.flow, undefined);
  assert.equal(api.automations[0].flow, undefined);
});

test('create: un archivo que no es JSON falla con exit 1 y sin tocar la API', async () => {
  const file = path.join(tmpDir, 'roto.json');
  fs.writeFileSync(file, '{ esto no es json');

  const { exitCode } = await run('automations', 'create', '-f', file);

  assert.equal(exitCode, 1);
  assert.equal(api.calls.length, 0);
});

// ── cortes de red: el estado queda en duda ────────────────────────────────

test('create: un corte de RED avisa que el estado es DESCONOCIDO, no que no se escribió', async () => {
  // El doble aplica y después mata la conexión: desde el cliente es
  // indistinguible de un POST que nunca llegó.
  api.killNext = { method: 'POST' };

  const { out, exitCode } = await run(
    'automations',
    'create',
    '-f',
    fileWith(fullAutomation()),
  );

  assert.equal(exitCode, 1);
  assert.match(out, /Estado DESCONOCIDO/);
  assert.match(out, /cce automations list/);
  // Y el consejo NO puede ser «reintentá tranquilo»: el item no tiene id.
  assert.match(out, /NO reapliques el archivo tal cual/);
  assert.match(out, /no se sabe si entró/);
  assert.doesNotMatch(out, /lo ACTUALIZA en vez de duplicarlo/);
  assert.equal(api.automations.length, 1, 'la API sí lo había aplicado');
});

test('create: un corte de red sobre un item CON id sí admite reintento', async () => {
  api.killNext = { method: 'POST' };

  const { out } = await run('automations', 'create', '-f', fileWith(fullAutomation('auto_1')));

  assert.match(out, /Estado DESCONOCIDO/);
  assert.match(out, /lo ACTUALIZA en vez de duplicarlo/);
});

test('delete: un corte de red avisa que el borrado pudo haberse aplicado', async () => {
  seed(fullAutomation('auto_1'));
  api.killNext = { method: 'DELETE' };

  const { out, exitCode } = await run('automations', 'delete', 'auto_1');

  assert.equal(exitCode, 1);
  assert.match(out, /Estado DESCONOCIDO/);
  assert.match(out, /el borrado de auto_1 pudo haberse aplicado/);
  assert.equal(api.automations.length, 0, 'y de hecho se aplicó');
});

test('disable: un corte de red avisa lo mismo', async () => {
  seed(fullAutomation('auto_1'));
  api.killNext = { method: 'PATCH' };

  const { out, exitCode } = await run('automations', 'disable', 'auto_1');

  assert.equal(exitCode, 1);
  assert.match(out, /Estado DESCONOCIDO/);
  assert.match(out, /el cambio sobre auto_1/);
});

test('un 404 NO dispara el aviso de estado desconocido: el servidor contestó', async () => {
  const { out, exitCode } = await run('automations', 'delete', 'auto_fantasma');

  assert.equal(exitCode, 1);
  assert.doesNotMatch(out, /Estado DESCONOCIDO/);
});

// ── delete / enable / disable ─────────────────────────────────────────────

test('delete: un id inexistente sale con exit 1 y el MENSAJE de la API', async () => {
  const { out, exitCode } = await run('automations', 'delete', 'auto_fantasma');

  assert.equal(exitCode, 1);
  assert.match(out, /No existe la automatización auto_fantasma/);
  // La regresión que reemplazó al chequeo local: imprimir la frase genérica.
  assert.doesNotMatch(out, /HTTP 404: Not Found/);
});

test('delete: borra la que corresponde y deja el resto', async () => {
  seed(fullAutomation('auto_1'), fullAutomation('auto_2'));

  const { out, exitCode } = await run('automations', 'delete', 'auto_1');

  assert.equal(exitCode, 0);
  assert.match(out, /Eliminada: auto_1/);
  assert.deepEqual(
    api.automations.map((a) => a.id),
    ['auto_2'],
  );
});

test('disable: escribe el booleano y no toca a las vecinas', async () => {
  seed(fullAutomation('auto_1'), fullAutomation('auto_2'));

  const { out, exitCode } = await run('automations', 'disable', 'auto_1');

  assert.equal(exitCode, 0);
  assert.match(out, /auto_1 deshabilitada/);
  assert.equal(api.automations[0].enabled, false);
  assert.equal(api.automations[1].enabled, true);
});

test('enable: un id inexistente sale con exit 1 y el MENSAJE de la API', async () => {
  const { out, exitCode } = await run('automations', 'enable', 'auto_fantasma');

  assert.equal(exitCode, 1);
  assert.match(out, /No existe la automatización auto_fantasma/);
  assert.doesNotMatch(out, /HTTP 404: Not Found/);
});

// ── el consejo tras un abort mixto ────────────────────────────────────────

test('abort mixto: el consejo nombra TODO lo que duplicaría, no sólo lo último', async () => {
  // Un item sin id ya aplicado, y el corte de red sobre el SIGUIENTE, también
  // sin id. El consejo anterior acotaba el riesgo al que cortó y contradecía al
  // stderr, que enumeraba además el primero — con lo cual invitaba a
  // re-POSTear justo lo que ya había entrado.
  api.afterCall = (nth, a) => {
    if (nth === 1) a.killNext = { method: 'POST' };
  };

  const { out } = await run(
    'automations',
    'create',
    '-f',
    fileWith([fullAutomation(), fullAutomation()]),
  );

  assert.match(out, /NO reapliques el archivo tal cual/);
  assert.match(out, /las que la API numeró \(auto_gen_0\)/);
  assert.match(out, /el item que cortó .*no se sabe si entró/);
});

test('«No quedó nada escrito» no se afirma cuando el estado es desconocido', async () => {
  api.killNext = { method: 'POST' };

  const { out } = await run('automations', 'create', '-f', fileWith(fullAutomation('auto_1')));

  assert.match(out, /Estado DESCONOCIDO/);
  assert.doesNotMatch(out, /No quedó nada escrito/);
});

test('«No quedó nada escrito» sí se afirma cuando la API contestó 400', async () => {
  const { out } = await run('automations', 'create', '-f', fileWith({ id: 'auto_a', name: '' }));

  assert.match(out, /No quedó nada escrito/);
});

// ── lo que el CLI se niega a mandar ───────────────────────────────────────

test('create: un trigger en null se rechaza acá, sin tocar la API', async () => {
  seed(fullAutomation('auto_1'));

  const { out, exitCode } = await run(
    'automations',
    'create',
    '-f',
    fileWith({ id: 'auto_1', trigger: null }),
  );

  assert.equal(exitCode, 1);
  assert.equal(api.calls.length, 0);
  assert.match(out, /"trigger" en null/);
  // Y la config sigue siendo legible.
  assert.equal(api.handle('GET', '/api/config/automations').status, 200);
});

test('create: una clave mal tipeada se rechaza con la sugerencia', async () => {
  seed(fullAutomation('auto_1'));

  const { out, exitCode } = await run(
    'automations',
    'create',
    '-f',
    fileWith({ id: 'auto_1', enabeld: false }),
  );

  assert.equal(exitCode, 1);
  assert.equal(api.calls.length, 0);
  assert.match(out, /"enabeld" \(¿"enabled"\?\)/);
  assert.equal(api.automations[0].enabled, true, 'no se tocó nada');
});

// ── el reporte, por un solo stream ────────────────────────────────────────

test('el reporte entero sale por stderr (se lee igual con stdout redirigido)', async () => {
  const real = console.log;
  const stdout: string[] = [];
  console.log = (...a: unknown[]) => stdout.push(a.join(' '));
  try {
    await run(
      'automations',
      'create',
      '-f',
      fileWith([fullAutomation('auto_a'), { id: 'auto_b', name: '' }]),
    );
  } finally {
    console.log = real;
  }

  assert.deepEqual(stdout, [], 'nada del reporte se fue por stdout');
});
