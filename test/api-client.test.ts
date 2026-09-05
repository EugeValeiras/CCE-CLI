import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { ApiError, apiErrorMessage } from '../src/lib/api-client.js';
import { createApiClient } from '../src/lib/api-client.js';

/**
 * CCE#107 — El interceptor, contra los cuerpos que la API manda DE VERDAD.
 *
 * El suite anterior mockeaba el cliente y afirmaba mensajes como
 * `'HTTP 400: Flujo inválido en flow[0].then'` que el interceptor real nunca
 * produjo: leía `data.error` (la frase genérica de Nest) en vez de
 * `data.message`, así que todo error del CLI salía como «HTTP 404: Not Found».
 * Los tests validaban una calidad de diagnóstico que el CLI no entregaba.
 *
 * Por eso acá hay un servidor HTTP de verdad devolviendo los cinco cuerpos que
 * esta API produce, verificados contra la instancia viva:
 *
 *   NotFoundException('No existe la automatización auto_1')
 *     → {"message":"No existe la automatización auto_1","error":"Not Found","statusCode":404}
 *
 * Si alguien vuelve a leer `data.error`, estos tests se caen.
 */

/** Cuerpos calcados de la API (Nest 10 + ValidationPipe global). */
const BODIES: Record<string, { status: number; body: unknown }> = {
  // NotFoundException con mensaje propio — el caso de delete/enable/disable.
  'not-found': {
    status: 404,
    body: {
      message: 'No existe la automatización auto_1',
      error: 'Not Found',
      statusCode: 404,
    },
  },
  // Ruta inexistente: el mensaje útil también vive en `message`.
  'route-not-found': {
    status: 404,
    body: { message: 'Cannot GET /api/config/nope', error: 'Not Found', statusCode: 404 },
  },
  // ValidationPipe: `message` es un ARRAY con un item por campo rechazado.
  'validation': {
    status: 400,
    body: {
      message: [
        'sourceAction must be one of the following values: on, off',
        'name should not be empty',
      ],
      error: 'Bad Request',
      statusCode: 400,
    },
  },
  // El 400 de `acceptFlow`: `errors` trae la RUTA del step que está mal.
  'flow': {
    status: 400,
    body: {
      statusCode: 400,
      message: 'Flujo inválido en la automatización auto_1',
      errors: ['flow[0].then[1].cond: condición desconocida', 'flow[2]: falta type'],
    },
  },
  // ConflictException(string) — el 409 del POST que dispara el upsert.
  'conflict': {
    status: 409,
    body: {
      message: 'Ya existe una automatización con id auto_1',
      error: 'Conflict',
      statusCode: 409,
    },
  },
  // ConflictException(objeto) — el 409 del PUT con If-Match stale. Nest usa el
  // objeto como body tal cual: no hay `error`, y sí `currentVersion`.
  'stale': {
    status: 409,
    body: {
      message:
        'Config de automations stale: If-Match 620 != versión actual 621. Refrescá (GET /api/config/automations) y reintentá.',
      currentVersion: 621,
    },
  },
  // Un 502 del reverse proxy: ni JSON de Nest ni nada útil.
  'html': { status: 502, body: '<html><body>Bad Gateway</body></html>' },
};

let baseUrl = '';
let server: http.Server;

before(async () => {
  server = http.createServer((req, res) => {
    const key = (req.url ?? '').replace('/api/', '');
    const hit = BODIES[key];
    if (!hit) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Config-Version': '620' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const isJson = typeof hit.body === 'object';
    res.writeHead(hit.status, { 'Content-Type': isJson ? 'application/json' : 'text/html' });
    res.end(isJson ? JSON.stringify(hit.body) : String(hit.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no arrancó el server de test');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  // Que no se lea el ~/.cce/config.json de quien corra los tests.
  process.env.CCE_API_TOKEN = 'token-de-test';
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const clientForTest = () => createApiClient({ apiUrl: baseUrl, timeoutMs: 2000 });

async function errorFrom(path: string): Promise<ApiError> {
  try {
    await clientForTest().get(`/${path}`);
  } catch (e) {
    assert.ok(e instanceof ApiError, `esperaba un ApiError, vino ${String(e)}`);
    return e;
  }
  throw new Error(`GET /${path} no falló`);
}

test('404: el mensaje del handler llega entero (no «Not Found»)', async () => {
  const e = await errorFrom('not-found');

  assert.equal(e.message, 'HTTP 404: No existe la automatización auto_1');
  assert.equal(e.status, 404);
  // La regresión concreta: leer `data.error` daba esto.
  assert.notEqual(e.message, 'HTTP 404: Not Found');
});

test('404 de ruta: también sale el mensaje, no la frase genérica', async () => {
  const e = await errorFrom('route-not-found');

  assert.equal(e.message, 'HTTP 404: Cannot GET /api/config/nope');
});

test('400 del ValidationPipe: el array de campos se une, no se pierde', async () => {
  const e = await errorFrom('validation');

  assert.equal(
    e.message,
    'HTTP 400: sourceAction must be one of the following values: on, off; name should not be empty',
  );
});

test('400 de flujo: el mensaje viene con la RUTA del step que está mal', async () => {
  const e = await errorFrom('flow');

  assert.equal(
    e.message,
    'HTTP 400: Flujo inválido en la automatización auto_1 ' +
      '(flow[0].then[1].cond: condición desconocida; flow[2]: falta type)',
  );
});

test('409 del POST: el status viaja como dato para que el upsert pueda ramificar', async () => {
  const e = await errorFrom('conflict');

  assert.equal(e.status, 409);
  assert.equal(e.message, 'HTTP 409: Ya existe una automatización con id auto_1');
});

test('409 del PUT stale: el body sin `error` no rompe, y currentVersion queda accesible', async () => {
  const e = await errorFrom('stale');

  assert.match(e.message, /Config de automations stale: If-Match 620 != versión actual 621/);
  assert.equal((e.data as { currentVersion: number }).currentVersion, 621);
});

test('una respuesta que no es JSON de Nest no se pierde ni explota', async () => {
  const e = await errorFrom('html');

  assert.equal(e.status, 502);
  assert.match(e.message, /Bad Gateway/);
});

test('apiErrorMessage: sin cuerpo, dice el status en vez de «undefined»', () => {
  assert.equal(apiErrorMessage(500, undefined), 'sin cuerpo (HTTP 500)');
  assert.equal(apiErrorMessage(500, null), 'sin cuerpo (HTTP 500)');
});

test('apiErrorMessage: cae a `error` sólo cuando no hay `message`', () => {
  assert.equal(apiErrorMessage(404, { error: 'Not Found', statusCode: 404 }), 'Not Found');
  assert.equal(apiErrorMessage(404, { message: '', error: 'Not Found' }), 'Not Found');
});

test('el header X-Config-Version llega al caller', async () => {
  const { headers } = await clientForTest().get('/lo-que-sea');

  assert.equal(headers['x-config-version'], '620');
});
