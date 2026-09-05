import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { registerConfigCommand } from '../src/commands/config.js';
import { FakeCceApi, Stored, fullAutomation } from './support/fake-cce-api.js';
import { runCli, withStdin } from './support/run-cli.js';

/**
 * CCE#107 — `config show` / `config set-remote automations`: el último replace
 * masivo que le queda al CLI.
 *
 * Lo que se fija acá es que la versión del `If-Match` venga de la lectura que
 * el usuario editó (no de un GET de recién, que coincidiría siempre), que una
 * versión que no es un número se corte ANTES de mandarla, y que este camino
 * avise del mismo no-op de `flowDerived` que avisa `create` — es la otra
 * puerta al mismo agujero.
 */

let api: FakeCceApi;
let close: () => Promise<void>;

before(() => {
  process.env.CCE_API_TOKEN = 'token-de-test';
  process.env.CCE_FORMAT = 'json';
});

after(() => {
  delete process.env.CCE_FORMAT;
});

beforeEach(async () => {
  api = new FakeCceApi([fullAutomation('auto_1') as Stored], 620);
  const started = await api.listen();
  close = started.close;
  process.env.CCE_API_URL = started.url;
});

afterEach(async () => {
  await close();
  process.exitCode = 0;
});

const run = (...argv: string[]) => runCli(registerConfigCommand, argv);
const setRemote = (stdin: string, ...argv: string[]) =>
  withStdin(stdin, () => run(...argv));

const puts = () => api.calls.filter((c) => c.method === 'PUT');

// ── show: de dónde sale la versión ────────────────────────────────────────

test('show automations: imprime la versión de ESTA lectura y cómo usarla', async () => {
  const { out, exitCode } = await run('config', 'show', 'automations');

  assert.equal(exitCode, 0);
  assert.match(out, /Versión de esta lectura: 620/);
  assert.match(out, /set-remote automations --if-match 620/);
});

test('show sin sección: no inventa un comando de escritura', async () => {
  const { out } = await run('config', 'show');

  assert.doesNotMatch(out, /set-remote undefined/);
});

// ── set-remote automations: el If-Match ───────────────────────────────────

test('set-remote automations: sin --if-match no se manda NADA', async () => {
  const { out, exitCode } = await setRemote(
    JSON.stringify([fullAutomation('auto_1')]),
    'config',
    'set-remote',
    'automations',
  );

  assert.equal(exitCode, 1);
  assert.match(out, /Falta --if-match/);
  assert.equal(puts().length, 0);
});

test('set-remote automations: una versión que no es número se corta ACÁ', async () => {
  // `--if-match *` sin comillas lo expande el shell al primer archivo del
  // directorio. La API compara con Number(): NaN, y responde el MISMO 409 que
  // una versión stale, con lo cual el CLI narraba «la config cambió desde la
  // versión autos.json» y mandaba a investigar un problema inexistente.
  const { out, exitCode } = await setRemote(
    JSON.stringify([fullAutomation('auto_1')]),
    'config',
    'set-remote',
    'automations',
    '--if-match',
    'autos.json',
  );

  assert.equal(exitCode, 1);
  assert.match(out, /--if-match inválido: "autos\.json"/);
  assert.match(out, /el \* sin comillas lo expande el shell/);
  assert.doesNotMatch(out, /cambió desde la versión/);
  assert.equal(puts().length, 0, 'no salió ningún PUT');
});

test('set-remote automations: con la versión correcta, escribe', async () => {
  const { out, exitCode } = await setRemote(
    JSON.stringify([fullAutomation('auto_1', { name: 'renombrada' })]),
    'config',
    'set-remote',
    'automations',
    '--if-match',
    '620',
  );

  assert.equal(exitCode, 0, out);
  assert.match(out, /actualizada/);
  assert.equal(api.automations[0].name, 'renombrada');
  assert.equal(puts()[0].ifMatch, '620');
});

test('set-remote automations: el escenario del incidente queda frenado', async () => {
  // El dueño exportó en la 620 y editó; la App creó algo en el medio (→ 621).
  api.handle('POST', '/api/config/automations', fullAutomation('auto_de_la_app'));

  const { out, exitCode } = await setRemote(
    JSON.stringify([fullAutomation('auto_1')]), // su archivo NO tiene la de la App
    'config',
    'set-remote',
    'automations',
    '--if-match',
    '620',
  );

  assert.equal(exitCode, 1);
  assert.match(out, /cambió desde la versión 620 que editabas/);
  assert.match(out, /ahora va por la 621/);
  assert.ok(
    api.automations.some((a) => a.id === 'auto_de_la_app'),
    'el replace masivo borró lo que había creado la App',
  );
});

// ── set-remote automations: el mismo no-op de flowDerived ─────────────────

test('set-remote automations: avisa que la API descarta flow/when en los items flowDerived', async () => {
  const exportada = fullAutomation('auto_1', {
    flowDerived: true,
    flow: [{ type: 'do', actions: [] }],
    when: [{ type: 'manual' }],
  });

  const { out, exitCode } = await setRemote(
    JSON.stringify([exportada]),
    'config',
    'set-remote',
    'automations',
    '--if-match',
    '620',
  );

  assert.equal(exitCode, 0, out);
  // Sin el aviso, esto era un «✓ actualizada» sobre una edición descartada:
  // el mismo agujero que `create`, por la otra puerta.
  assert.match(out, /flowDerived/);
  assert.match(out, /NO se persiste/);
  assert.equal(api.automations[0].flow, undefined, 'la API la descartó, como en producción');
});

test('set-remote automations: sin flowDerived no hay ruido', async () => {
  const { out } = await setRemote(
    JSON.stringify([fullAutomation('auto_1')]),
    'config',
    'set-remote',
    'automations',
    '--if-match',
    '620',
  );

  assert.doesNotMatch(out, /flowDerived/);
});

// ── otras secciones ───────────────────────────────────────────────────────

test('set-remote hue: --if-match se ignora y se dice', async () => {
  const { out } = await setRemote('{"bridgeIp":"1.2.3.4"}', 'config', 'set-remote', 'hue', '--if-match', '620');

  assert.match(out, /--if-match se ignora en \/hue/);
});
