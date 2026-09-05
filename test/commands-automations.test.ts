import assert from 'node:assert/strict';
import { Command } from 'commander';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { registerAutomationsCommand } from '../src/commands/automations.js';

/**
 * CCE#107 — La capa de comandos: exit code y reporte.
 *
 * Los otros dos suites cubren la lib y el interceptor. Lo que ejercita éste es
 * lo que ve el operador: qué se imprime tras un abort a mitad de camino y con
 * qué código sale el proceso. Es la mitad del contrato del fail-fast — un
 * reporte que no se emite, o un exit 0 sobre un fallo, valen lo mismo que
 * fallar en silencio.
 *
 * Corre contra un servidor HTTP local que imita a la API (cuerpos de error de
 * Nest incluidos). Nunca sale a la red.
 */

interface Stored extends Record<string, unknown> {
  id: string;
}

let baseUrl = '';
let server: http.Server;
let tmpDir = '';
let state: Stored[] = [];
/** Devuelve 400 al PATCH/POST de este id, para forzar el corte. */
let rejectId = '';

const nestBody = (status: number, message: string | string[], error: string) => ({
  message,
  error,
  statusCode: status,
});

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '', 'http://x');
      const p = url.pathname;
      const body = raw ? JSON.parse(raw) : undefined;
      const json = (status: number, payload: unknown): void => {
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'X-Config-Version': String(600 + state.length),
        });
        res.end(JSON.stringify(payload));
      };
      const idFromPath = decodeURIComponent(p.replace('/api/config/automations/', ''));

      if (p === '/api/config/automations' && req.method === 'POST') {
        const id = String(body.id ?? `auto_acuñado_${state.length}`);
        if (rejectId && (body.id === rejectId || body.name === rejectId)) {
          return json(
            400,
            nestBody(400, ['name should not be empty'], 'Bad Request'),
          );
        }
        if (state.some((a) => a.id === id)) {
          return json(
            409,
            nestBody(409, `Ya existe una automatización con id ${id}`, 'Conflict'),
          );
        }
        state.push({ ...body, id });
        return json(201, { success: true, automation: { id }, version: 600 + state.length });
      }
      if (p.startsWith('/api/config/automations/') && req.method === 'PATCH') {
        const i = state.findIndex((a) => a.id === idFromPath);
        if (i === -1) {
          return json(
            404,
            nestBody(404, `No existe la automatización ${idFromPath}`, 'Not Found'),
          );
        }
        // Como la API: flowDerived:true hace que flow/when se descarten.
        const { id: _drop, ...clean } = body as Record<string, unknown>;
        if (clean.flowDerived === true) {
          delete clean.flow;
          delete clean.when;
          delete clean.flowDerived;
        }
        state[i] = { ...state[i], ...clean };
        return json(200, { success: true, automation: state[i], version: 600 });
      }
      if (p.startsWith('/api/config/automations/') && req.method === 'DELETE') {
        const i = state.findIndex((a) => a.id === idFromPath);
        if (i === -1) {
          return json(
            404,
            nestBody(404, `No existe la automatización ${idFromPath}`, 'Not Found'),
          );
        }
        state.splice(i, 1);
        return json(200, { success: true, version: 600 });
      }
      json(404, nestBody(404, `Cannot ${req.method} ${p}`, 'Not Found'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no arrancó el server de test');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-cli-test-'));
  // Que ni la URL ni el token salgan del ~/.cce/config.json de quien corra esto.
  process.env.CCE_API_URL = baseUrl;
  process.env.CCE_API_TOKEN = 'token-de-test';
  process.env.CCE_FORMAT = 'table';
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  // `process.exitCode` es global: sin esto, un test que verifica el exit 1
  // haría salir con 1 al runner entero.
  process.exitCode = 0;
  state = [];
  rejectId = '';
});

/** Corre `cce automations …` capturando lo que imprime. */
async function run(...argv: string[]): Promise<{ out: string; exitCode: number }> {
  const lines: string[] = [];
  const capture =
    () =>
    (...args: unknown[]): void => {
      lines.push(args.map((a) => String(a)).join(' '));
    };
  const realLog = console.log;
  const realError = console.error;
  const realWarn = console.warn;
  console.log = capture();
  console.error = capture();
  console.warn = capture();
  const program = new Command();
  program.exitOverride();
  program.option('--api-url <url>').option('--format <format>', '', 'table');
  registerAutomationsCommand(program);
  try {
    await program.parseAsync(argv, { from: 'user' });
  } finally {
    console.log = realLog;
    console.error = realError;
    console.warn = realWarn;
  }
  return { out: lines.join('\n'), exitCode: Number(process.exitCode ?? 0) };
}

function fileWith(contenido: unknown): string {
  const file = path.join(tmpDir, `auto-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(contenido));
  return file;
}

const auto = (id?: string, extra: Record<string, unknown> = {}) => ({
  ...(id ? { id } : {}),
  name: id ? `auto ${id}` : 'sin id',
  enabled: true,
  ...extra,
});

// ── create ────────────────────────────────────────────────────────────────

test('create: alta exitosa → exit 0 y «Creadas»', async () => {
  const { out, exitCode } = await run('automations', 'create', '-f', fileWith(auto('auto_1')));

  assert.equal(exitCode, 0);
  assert.match(out, /Creadas \(1\): auto_1/);
  assert.deepEqual(state.map((a) => a.id), ['auto_1']);
});

test('create: sobre un id existente → «Actualizadas», no «Creadas»', async () => {
  state.push({ id: 'auto_1', name: 'vieja' });

  const { out, exitCode } = await run(
    'automations',
    'create',
    '-f',
    fileWith(auto('auto_1', { name: 'nueva' })),
  );

  assert.equal(exitCode, 0);
  assert.match(out, /Actualizadas \(1\): auto_1/);
  assert.doesNotMatch(out, /Creadas/);
  assert.equal(state[0].name, 'nueva');
});

test('create: abort a mitad → exit 1, y el reporte entero se emite', async () => {
  rejectId = 'auto_b';

  const { out, exitCode } = await run(
    'automations',
    'create',
    '-f',
    fileWith([auto('auto_a'), auto('auto_b'), auto('auto_c')]),
  );

  assert.equal(exitCode, 1);
  // Las cuatro partes del reporte, ninguna truncada por un process.exit().
  assert.match(out, /Creadas \(1\): auto_a/);
  assert.match(out, /Falló en auto_b: HTTP 400: name should not be empty/);
  assert.match(out, /Sin intentar \(1\): auto_c/);
  assert.match(out, /reintentá/);
  // Y auto_c no se escribió.
  assert.deepEqual(state.map((a) => a.id), ['auto_a']);
});

test('create: si lo aplicado tenía id, el consejo dice que reaplicar es seguro', async () => {
  rejectId = 'auto_b';

  const { out } = await run(
    'automations',
    'create',
    '-f',
    fileWith([auto('auto_a'), auto('auto_b')]),
  );

  assert.match(out, /los ACTUALIZA en vez de duplicarlos/);
  assert.doesNotMatch(out, /NO reapliques/);
});

test('create: con un item SIN id aplicado, el consejo advierte que reaplicar DUPLICA', async () => {
  rejectId = 'auto_b';

  const { out } = await run('automations', 'create', '-f', fileWith([auto(), auto('auto_b')]));

  // El id que acuñó la API, mapeado a cómo lo nombraba el archivo: sin esto el
  // dueño no tiene con qué editar el archivo antes de reintentar.
  assert.match(out, /Con id generado por la API \(1\)/);
  assert.match(out, /«sin id» → auto_acuñado_0/);
  assert.match(out, /NO reapliques el archivo tal cual/);
  assert.match(out, /dos automatizaciones idénticas sobre el mismo trigger/);
});

test('create: falla el primer item → dice que no quedó nada escrito', async () => {
  rejectId = 'auto_a';

  const { out, exitCode } = await run('automations', 'create', '-f', fileWith([auto('auto_a')]));

  assert.equal(exitCode, 1);
  assert.match(out, /no quedó nada escrito/);
  assert.equal(state.length, 0);
});

test('create: una automatización exportada avisa que el flujo editado NO se guarda', async () => {
  state.push({ id: 'auto_1', name: 'vieja' });
  const exportada = auto('auto_1', {
    flowDerived: true,
    flow: [{ type: 'do', actions: [] }],
    when: [{ type: 'manual' }],
  });

  const { out, exitCode } = await run('automations', 'create', '-f', fileWith(exportada));

  assert.equal(exitCode, 0);
  assert.match(out, /Actualizadas \(1\): auto_1/);
  // El punto: el ✓ solo sería un no-op silencioso.
  assert.match(out, /flowDerived/);
  assert.match(out, /NO se persiste/);
  assert.equal(state[0].flow, undefined, 'el server descartó flow, como hace la API real');
});

test('create: un archivo que no es JSON falla con exit 1 y sin tocar la API', async () => {
  const file = path.join(tmpDir, 'roto.json');
  fs.writeFileSync(file, '{ esto no es json');

  const { exitCode } = await run('automations', 'create', '-f', file);

  assert.equal(exitCode, 1);
  assert.equal(state.length, 0);
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
  state.push({ id: 'auto_1' }, { id: 'auto_2' });

  const { out, exitCode } = await run('automations', 'delete', 'auto_1');

  assert.equal(exitCode, 0);
  assert.match(out, /Eliminada: auto_1/);
  assert.deepEqual(state.map((a) => a.id), ['auto_2']);
});

test('disable: escribe el booleano y no toca a las vecinas', async () => {
  state.push({ id: 'auto_1', enabled: true }, { id: 'auto_2', enabled: true });

  const { out, exitCode } = await run('automations', 'disable', 'auto_1');

  assert.equal(exitCode, 0);
  assert.match(out, /auto_1 deshabilitada/);
  assert.equal(state[0].enabled, false);
  assert.equal(state[1].enabled, true);
});

test('enable: un id inexistente sale con exit 1 y el MENSAJE de la API', async () => {
  const { out, exitCode } = await run('automations', 'enable', 'auto_fantasma');

  assert.equal(exitCode, 1);
  assert.match(out, /No existe la automatización auto_fantasma/);
  assert.doesNotMatch(out, /HTTP 404: Not Found/);
});
