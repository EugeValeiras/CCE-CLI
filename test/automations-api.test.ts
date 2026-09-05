import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, TransportError, apiErrorMessage } from '../src/lib/api-client.js';
import {
  AutomationInput,
  AutomationsHttp,
  HttpResponse,
  deleteAutomation,
  prepareBulkAutomations,
  replaceAllAutomations,
  retryIsSafe,
  setAutomationEnabled,
  upsertAutomations,
} from '../src/lib/automations-api.js';
import { FakeCceApi, fullAutomation } from './support/fake-cce-api.js';

/**
 * CCE#107 — Dos clases de test, a propósito:
 *
 *  - Con `fakeHttp`, un espía pelado: afirman MÉTODO y RUTA. El bug que cierra
 *    este issue no era un cálculo mal hecho sino una forma de escribir, así que
 *    lo que hay que fijar es qué peticiones salen y cuáles no.
 *  - Con `FakeCceApi`, un doble que valida como la API real (ValidationPipe
 *    incluido): afirman el CONTRATO. La versión anterior de este suite usaba un
 *    fake complaciente que respondía 409 sin validar el body, y por eso daba
 *    verde un caso —el parche parcial— que contra la API real falla con 400.
 *
 * Los errores se arman siempre con `apiErrorMessage`, el mismo que usa el
 * interceptor real; ver `api-client.test.ts`.
 */

interface Call {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}

type Responder = (call: Call) => HttpResponse<unknown>;

const OK: HttpResponse<unknown> = { data: { success: true } };

function fakeHttp(respond: Responder = () => OK): { client: AutomationsHttp; calls: Call[] } {
  const calls: Call[] = [];
  const record = async <T>(call: Call): Promise<HttpResponse<T>> => {
    calls.push(call);
    return respond(call) as HttpResponse<T>;
  };
  const sentHeaders = (config?: unknown): Record<string, string> | undefined =>
    (config as { headers?: Record<string, string> } | undefined)?.headers;
  const client: AutomationsHttp = {
    delete: <T>(url: string, config?: unknown) =>
      record<T>({ method: 'DELETE', url, headers: sentHeaders(config) }),
    post: <T>(url: string, body?: unknown, config?: unknown) =>
      record<T>({ method: 'POST', url, body, headers: sentHeaders(config) }),
    patch: <T>(url: string, body?: unknown, config?: unknown) =>
      record<T>({ method: 'PATCH', url, body, headers: sentHeaders(config) }),
    put: <T>(url: string, body?: unknown, config?: unknown) =>
      record<T>({ method: 'PUT', url, body, headers: sentHeaders(config) }),
  };
  return { client, calls };
}

// ── errores como los arma el CLI de verdad ────────────────────────────────

const nestError = (status: number, body: unknown): ApiError =>
  new ApiError(`HTTP ${status}: ${apiErrorMessage(status, body)}`, status, body);

const conflict = (id: string): ApiError =>
  nestError(409, {
    message: `Ya existe una automatización con id ${id}`,
    error: 'Conflict',
    statusCode: 409,
  });

const notFound = (id: string): ApiError =>
  nestError(404, {
    message: `No existe la automatización ${id}`,
    error: 'Not Found',
    statusCode: 404,
  });

const validationError = (...msgs: string[]): ApiError =>
  nestError(400, { message: msgs, error: 'Bad Request', statusCode: 400 });

const staleError = (sent: string, current: number): ApiError =>
  nestError(409, {
    message: `Config de automations stale: If-Match ${sent} != versión actual ${current}.`,
    currentVersion: current,
  });

const created = (id: string): HttpResponse<unknown> => ({
  data: { success: true, automation: { id }, version: 621 },
});

const auto = (id?: string): AutomationInput => fullAutomation(id) as AutomationInput;

// ── create: qué peticiones salen ──────────────────────────────────────────

test('create: una automatización nueva sale por POST y nada más', async () => {
  const { client, calls } = fakeHttp(() => created('auto_nueva'));

  const report = await upsertAutomations(client, [auto('auto_nueva')]);

  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    ['POST /config/automations'],
  );
  assert.deepEqual(report.applied, [
    { id: 'auto_nueva', label: 'auto_nueva', action: 'created', idGeneratedByServer: false },
  ]);
  assert.equal(report.failed, undefined);
});

test('create: sin id, el id que reporta es el que generó la API', async () => {
  const { client, calls } = fakeHttp(() => created('auto_generado_por_el_server'));

  const report = await upsertAutomations(client, [auto()]);

  assert.equal(calls.length, 1);
  assert.deepEqual(report.applied, [
    {
      id: 'auto_generado_por_el_server',
      label: '«sin id»',
      action: 'created',
      idGeneratedByServer: true,
    },
  ]);
});

test('create: un id que ya existe cae al PATCH del item', async () => {
  const { client, calls } = fakeHttp((call) => {
    if (call.method === 'POST') throw conflict('auto_vieja');
    return OK;
  });

  const report = await upsertAutomations(client, [auto('auto_vieja')]);

  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    ['POST /config/automations', 'PATCH /config/automations/auto_vieja'],
  );
  // El id va en el path, no en el body: la API lo descartaría igual
  // (whitelist), y mandarlo sugeriría que se puede cambiar.
  assert.equal((calls[1].body as Record<string, unknown>).id, undefined);
  assert.equal(report.applied[0].action, 'updated');
});

test('create: el id del path va escapado', async () => {
  const { client, calls } = fakeHttp((call) => {
    if (call.method === 'POST') throw conflict('auto/raro 1');
    return OK;
  });

  await upsertAutomations(client, [auto('auto/raro 1')]);

  assert.equal(calls[1].url, '/config/automations/auto%2Fraro%201');
});

test('create: ningún camino manda el PUT masivo', async () => {
  const { client, calls } = fakeHttp((call) => {
    if (call.method === 'POST') throw conflict('auto_x');
    return OK;
  });

  await upsertAutomations(client, [auto('auto_x'), auto('auto_y')]);

  assert.ok(!calls.some((c) => c.method === 'PUT'));
  // `AutomationsHttp` ni siquiera declara `get`: el read-modify-write no puede
  // volver sin cambiar el tipo, así que el invariante es de compilación.
});

test('create: un error que no es 400/409 corta ahí y NO se intenta el resto', async () => {
  const { client, calls } = fakeHttp((call) => {
    const id = (call.body as { id: string }).id;
    if (id === 'auto_b') throw nestError(401, { message: 'Token inválido', error: 'Unauthorized' });
    return created(id);
  });

  const report = await upsertAutomations(client, [
    auto('auto_a'),
    auto('auto_b'),
    auto('auto_c'),
  ]);

  assert.deepEqual(
    report.applied.map((o) => o.id),
    ['auto_a'],
  );
  assert.equal(report.failed?.message, 'HTTP 401: Token inválido');
  assert.deepEqual(report.notAttempted, ['auto_c']);
  assert.equal(calls.length, 2);
});

test('create: un 2xx sin id es ESTADO DESCONOCIDO — la automatización se creó igual', async () => {
  const { client } = fakeHttp(() => ({ data: { success: true } }));

  const report = await upsertAutomations(client, [auto()]);

  assert.equal(report.applied.length, 0);
  assert.match(report.failed?.message ?? '', /no devolvió su id/);
  // La API respondió 2xx: existe. Decir «no se escribió, reintentá» duplicaría.
  assert.equal(report.failed?.stateUnknown, true);
  assert.equal(retryIsSafe(report), false);
});

// ── create: el contrato real (doble que valida como la API) ───────────────

test('create: un PARCHE PARCIAL va DIRECTO al PATCH — ni se intenta el POST', async () => {
  // La forma del body decide el método: sin las cuatro claves requeridas no
  // hay nada que crear, así que probar el POST sólo gasta un round-trip y una
  // validación que va a fallar.
  const api = new FakeCceApi([fullAutomation('auto_1', { enabled: true }) as never]);

  const report = await upsertAutomations(api.asHttpClient(), [
    { id: 'auto_1', enabled: false } as AutomationInput,
  ]);

  assert.deepEqual(
    api.calls.map((c) => `${c.method} ${c.path}`),
    ['PATCH /api/config/automations/auto_1'],
  );
  assert.equal(report.failed, undefined, report.failed?.message);
  assert.equal(report.applied[0].action, 'updated');
  assert.equal(api.automations[0].enabled, false);
  // Y el merge es top-level: lo que el parche no trae, queda.
  assert.equal(api.automations[0].name, 'auto auto_1');
});

test('create: un parche sobre un id que NO existe dice «no existe», no «name must be a string»', async () => {
  // Con el fallback viejo, este 404 se descartaba y salía el 400 del POST: el
  // operador completaba el body y terminaba CREANDO una automatización que no
  // quería, sobre el mismo trigger que la que quiso editar.
  const api = new FakeCceApi([]);

  const report = await upsertAutomations(api.asHttpClient(), [
    { id: 'auto_con_typo_en_el_id', enabled: false } as AutomationInput,
  ]);

  assert.deepEqual(
    api.calls.map((c) => c.method),
    ['PATCH'],
  );
  assert.match(report.failed?.message ?? '', /No existe la automatización auto_con_typo_en_el_id/);
  assert.equal(api.automations.length, 0);
});

test('create: un alta COMPLETA nueva entra de una, sin PATCH', async () => {
  const api = new FakeCceApi([]);

  const report = await upsertAutomations(api.asHttpClient(), [auto('auto_nueva')]);

  assert.deepEqual(
    api.calls.map((c) => c.method),
    ['POST'],
  );
  assert.equal(report.applied[0].action, 'created');
});

test("create: un alta con sourceAction 'toggle' entra por POST — el DTO angosto del PATCH no la toca", async () => {
  // Si el upsert fuera PATCH-first, esta alta perfectamente válida moriría con
  // un 400 del DTO angosto (EugeValeiras/CCE#109).
  const api = new FakeCceApi([]);
  const conToggle = fullAutomation('auto_grupo', {
    source: 'group',
    sourceAction: 'toggle',
  }) as AutomationInput;

  const report = await upsertAutomations(api.asHttpClient(), [conToggle]);

  assert.deepEqual(
    api.calls.map((c) => c.method),
    ['POST'],
  );
  assert.equal(report.failed, undefined);
  assert.equal(api.automations[0].sourceAction, 'toggle');
});

test("create: EDITAR una con sourceAction 'toggle' choca con el DTO angosto y se explica", async () => {
  const api = new FakeCceApi([fullAutomation('auto_grupo') as never]);
  const conToggle = fullAutomation('auto_grupo', {
    name: 'renombrada',
    source: 'group',
    sourceAction: 'toggle',
  }) as AutomationInput;

  const report = await upsertAutomations(api.asHttpClient(), [conToggle]);

  // El POST dio 409 (o sea: el body ES válido como AutomationConfig), y el
  // PATCH del MISMO body da 400. Sólo puede ser la asimetría de DTOs.
  assert.match(report.failed?.message ?? '', /sourceAction must be one of/);
  assert.match(report.failed?.message ?? '', /EugeValeiras\/CCE#109/);
});

test('create: un 400 del PATCH que NO viene de un 409 no culpa a la API', async () => {
  // Acá el POST rechazó el body (400) y el PATCH también: no hay evidencia de
  // asimetría, así que pegar el hint invitaría a descartar un error del
  // archivo como bug ajeno.
  const api = new FakeCceApi([fullAutomation('auto_1') as never]);

  const report = await upsertAutomations(api.asHttpClient(), [
    { id: 'auto_1', name: '' } as AutomationInput,
  ]);

  assert.match(report.failed?.message ?? '', /name should not be empty/);
  assert.doesNotMatch(report.failed?.message ?? '', /CCE#109/);
});

// ── create: cortes de transporte (estado desconocido) ─────────────────────

test('create: un corte de RED marca el estado como desconocido, no como «no se escribió»', async () => {
  const api = new FakeCceApi([]);
  // El server aplica y la respuesta se pierde: exactamente lo que no se puede
  // distinguir desde el cliente.
  api.killNext = { method: 'POST' };

  const report = await upsertAutomations(api.asHttpClient(), [auto()]);

  assert.equal(report.failed?.stateUnknown, true);
  assert.equal(report.failed?.hadId, false);
  assert.equal(api.automations.length, 1, 'el doble SÍ lo aplicó');
  // Y por eso reintentar no es seguro: crearía un segundo.
  assert.equal(retryIsSafe(report), false);
});

test('create: un corte de red sobre un item CON id sí es re-aplicable', async () => {
  const api = new FakeCceApi([]);
  api.killNext = { method: 'POST' };

  const report = await upsertAutomations(api.asHttpClient(), [auto('auto_1')]);

  assert.equal(report.failed?.stateUnknown, true);
  assert.equal(report.failed?.hadId, true);
  // Con id, el segundo intento actualiza en vez de duplicar.
  assert.equal(retryIsSafe(report), true);
});

test('create: un corte de red NO se reintenta por otra vía', async () => {
  const api = new FakeCceApi([fullAutomation('auto_1') as never]);
  api.killNext = { method: 'POST' };

  await upsertAutomations(api.asHttpClient(), [auto('auto_1')]);

  // Nada de PATCH detrás de un POST que pudo haberse aplicado.
  assert.deepEqual(
    api.calls.map((c) => c.method),
    ['POST'],
  );
});

test('un 404/409 NO es estado desconocido: el servidor contestó', async () => {
  const { client } = fakeHttp(() => {
    throw conflict('auto_1');
  });

  const report = await upsertAutomations(client, [auto()]);

  assert.equal(report.failed?.stateUnknown, false);
});

// ── reintentar después de un abort ────────────────────────────────────────

test('reintentar es seguro sólo si TODO lo aplicado tenía id', async () => {
  const { client } = fakeHttp((call) => {
    const id = (call.body as { id?: string }).id;
    if (id === 'auto_malo') throw validationError('name should not be empty');
    return created(id ?? 'auto_acuñado_por_el_server');
  });

  const conId = await upsertAutomations(client, [auto('auto_a'), auto('auto_malo')]);
  assert.equal(retryIsSafe(conId), true);

  const sinId = await upsertAutomations(client, [auto(), auto('auto_malo')]);
  assert.equal(retryIsSafe(sinId), false);
  assert.equal(sinId.applied[0].idGeneratedByServer, true);
  assert.equal(sinId.applied[0].label, '«sin id»');
});

test('reintentar es seguro cuando no se aplicó nada y el servidor contestó', async () => {
  const { client } = fakeHttp(() => {
    throw validationError('name should not be empty');
  });

  const report = await upsertAutomations(client, [auto('auto_a')]);

  assert.equal(report.applied.length, 0);
  assert.equal(retryIsSafe(report), true);
});

// ── flowDerived: el no-op silencioso ──────────────────────────────────────

const exportada = (id: string): AutomationInput =>
  fullAutomation(id, {
    flowDerived: true,
    flow: [{ type: 'do', actions: [] }],
    when: [{ type: 'manual' }],
  }) as AutomationInput;

test('create: el flujo derivado NO se manda — se quita antes, y se dice', async () => {
  const api = new FakeCceApi([fullAutomation('auto_1') as never]);

  const report = await upsertAutomations(api.asHttpClient(), [exportada('auto_1')]);

  assert.equal(report.applied[0].action, 'updated');
  // Lo que sale por el cable ya no lleva el flujo proyectado: mandarlo para que
  // la API lo descarte es lo que hacía creer que se había guardado.
  const enviado = api.calls.at(-1)?.body as Record<string, unknown>;
  assert.equal(enviado.flow, undefined);
  assert.equal(enviado.when, undefined);
  assert.equal(enviado.flowDerived, undefined);
  assert.equal(enviado.name, 'auto auto_1');
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /se quitaron "flow"\/"when"/);
  // Y el consejo ya no es «quitá flowDerived y reaplicá», que corrompe si
  // además se editaron las actions.
  assert.doesNotMatch(report.warnings[0], /quitá "flowDerived" de ese item/);
});

test('create: el aviso del flujo derivado sale UNA vez, no por item', async () => {
  const api = new FakeCceApi([]);

  const report = await upsertAutomations(api.asHttpClient(), [
    exportada('auto_a'),
    exportada('auto_b'),
  ]);

  assert.equal(report.failed, undefined);
  assert.equal(report.warnings.length, 1);
});

test('el replace masivo también le saca el flujo derivado a cada item', () => {
  const { body, warnings } = prepareBulkAutomations([
    exportada('auto_1'),
    fullAutomation('auto_2'),
  ]);

  const enviados = body as AutomationInput[];
  assert.equal(enviados[0].flow, undefined);
  assert.equal(enviados[0].when, undefined);
  assert.equal(enviados[0].flowDerived, undefined);
  assert.equal(enviados[0].name, 'auto auto_1', 'el resto del item viaja igual');
  assert.deepEqual(enviados[1], fullAutomation('auto_2'));
  assert.equal(warnings.length, 1);
});

test('sin flowDerived no se toca nada y no hay aviso', () => {
  const { body, warnings } = prepareBulkAutomations([fullAutomation('auto_1')]);

  assert.deepEqual(body, [fullAutomation('auto_1')]);
  assert.deepEqual(warnings, []);
});

// ── delete / enable / disable ─────────────────────────────────────────────

test('delete: un DELETE al item, y nada del array', async () => {
  const { client, calls } = fakeHttp();

  await deleteAutomation(client, 'auto_1');

  assert.deepEqual(calls, [
    { method: 'DELETE', url: '/config/automations/auto_1', headers: undefined },
  ]);
});

test('delete: un id inexistente propaga el 404 con el mensaje de la API', async () => {
  const { client } = fakeHttp(() => {
    throw notFound('auto_fantasma');
  });

  await assert.rejects(
    () => deleteAutomation(client, 'auto_fantasma'),
    /HTTP 404: No existe la automatización auto_fantasma/,
  );
});

test('enable/disable: PATCH del item con el booleano y nada más', async () => {
  const { client, calls } = fakeHttp();

  await setAutomationEnabled(client, 'auto_1', true);
  await setAutomationEnabled(client, 'auto_1', false);

  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url} ${JSON.stringify(c.body)}`),
    [
      'PATCH /config/automations/auto_1 {"enabled":true}',
      'PATCH /config/automations/auto_1 {"enabled":false}',
    ],
  );
});

test('enable: un id inexistente propaga el 404 con el mensaje de la API', async () => {
  const { client } = fakeHttp(() => {
    throw notFound('auto_fantasma');
  });

  await assert.rejects(
    () => setAutomationEnabled(client, 'auto_fantasma', true),
    /HTTP 404: No existe la automatización auto_fantasma/,
  );
});

// ── replace masivo (config set-remote automations) ────────────────────────

test('replace masivo: manda el If-Match que le dieron y no lee la versión por su cuenta', async () => {
  const { client, calls } = fakeHttp();

  await replaceAllAutomations(client, [auto('auto_1')], '620');

  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    ['PUT /config/automations'],
  );
  assert.deepEqual(calls[0].headers, { 'If-Match': '620' });
});

test('replace masivo: sin versión no se envía nada, y dice cómo conseguirla', async () => {
  const { client, calls } = fakeHttp();

  await assert.rejects(
    () => replaceAllAutomations(client, [], ''),
    (e: Error) => {
      assert.match(e.message, /Falta --if-match/);
      assert.match(e.message, /cce config show automations/);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('replace masivo: una versión que no es número se rechaza ACÁ, no como «la config cambió»', async () => {
  // La API compara con Number(If-Match): 'autos.json' da NaN y devuelve el
  // MISMO 409 que una versión stale. Sin el chequeo local, `--if-match *` sin
  // comillas (que el shell expande al primer archivo del directorio) se
  // reportaba como «cambió desde la versión autos.json».
  const { client, calls } = fakeHttp();

  await assert.rejects(
    () => replaceAllAutomations(client, [], 'autos.json'),
    (e: Error) => {
      assert.match(e.message, /--if-match inválido: "autos.json"/);
      assert.match(e.message, /el \* sin comillas lo expande el shell/);
      assert.doesNotMatch(e.message, /cambió desde la versión/);
      return true;
    },
  );
  assert.equal(calls.length, 0, 'no se manda nada con una versión inválida');
});

test("replace masivo: '*' es válido (escribir sin chequeo, explícito)", async () => {
  const { client, calls } = fakeHttp();

  await replaceAllAutomations(client, [], '*');

  assert.deepEqual(calls[0].headers, { 'If-Match': '*' });
});

test('replace masivo: el 409 dice qué versión editabas y cuál corre ahora', async () => {
  const { client } = fakeHttp(() => {
    throw staleError('620', 621);
  });

  await assert.rejects(
    () => replaceAllAutomations(client, [], '620'),
    (e: Error) => {
      assert.match(e.message, /cambió desde la versión 620 que editabas/);
      assert.match(e.message, /ahora va por la 621/);
      assert.match(e.message, /No se escribió nada/);
      return true;
    },
  );
});

test('replace masivo: el escenario del incidente — editar 10 minutos y reescribir encima', async () => {
  // El dueño exportó en la 620; la App creó una automatización mientras él
  // editaba. Su archivo NO la tiene.
  const api = new FakeCceApi([fullAutomation('auto_1') as never], 620);
  api.handle('POST', '/api/config/automations', fullAutomation('auto_de_la_app'));

  await assert.rejects(
    () => replaceAllAutomations(api.asHttpClient(), [fullAutomation('auto_1')], '620'),
    /cambió desde la versión 620/,
  );
  assert.ok(
    api.automations.some((a) => a.id === 'auto_de_la_app'),
    'el replace masivo borró la automatización que había creado la App',
  );
});

// ── el criterio que da sentido al issue ───────────────────────────────────

test('create: una automatización creada por otra vía EN EL MEDIO sigue existiendo al terminar', async () => {
  const api = new FakeCceApi([fullAutomation('auto_ya_estaba') as never]);
  // La ajena entra después de la primera llamada del CLI: con el patrón viejo
  // esa llamada era el GET y la siguiente el PUT del array leído antes.
  api.afterCall = (nth, a) => {
    if (nth === 1) a.automations.push(fullAutomation('auto_de_la_app') as never);
  };

  const report = await upsertAutomations(api.asHttpClient(), [
    auto('auto_del_cli_1'),
    auto('auto_del_cli_2'),
  ]);

  assert.equal(report.failed, undefined);
  assert.deepEqual(
    api.automations.map((a) => a.id),
    ['auto_ya_estaba', 'auto_del_cli_1', 'auto_de_la_app', 'auto_del_cli_2'],
  );
});

test('enable: cambiar un booleano no puede pisar una escritura ajena ni a las vecinas', async () => {
  const api = new FakeCceApi([
    fullAutomation('auto_1') as never,
    fullAutomation('auto_2') as never,
  ]);
  api.afterCall = (nth, a) => {
    if (nth === 1) a.automations.push(fullAutomation('auto_de_la_app') as never);
  };

  await setAutomationEnabled(api.asHttpClient(), 'auto_1', false);

  assert.equal(api.automations.find((a) => a.id === 'auto_1')?.enabled, false);
  assert.equal(api.automations.find((a) => a.id === 'auto_2')?.enabled, true);
  assert.ok(api.automations.some((a) => a.id === 'auto_de_la_app'));
});

test('delete: borrar una no puede pisar una escritura ajena', async () => {
  const api = new FakeCceApi([
    fullAutomation('auto_1') as never,
    fullAutomation('auto_2') as never,
  ]);
  api.afterCall = (nth, a) => {
    if (nth === 1) a.automations.push(fullAutomation('auto_de_la_app') as never);
  };

  await deleteAutomation(api.asHttpClient(), 'auto_1');

  assert.deepEqual(
    api.automations.map((a) => a.id),
    ['auto_2', 'auto_de_la_app'],
  );
});

test('el doble deja constancia: un TransportError no es un ApiError', () => {
  assert.ok(new TransportError('x', 'ECONNRESET', true) instanceof Error);
  assert.ok(!(new TransportError('x', 'ECONNRESET', true) instanceof ApiError));
});

// ── lo que NO se manda: la API lo acepta y después se rompe ───────────────

test('create: un `null` NO sale del CLI — por PATCH la API lo acepta y deja la config ilegible', async () => {
  const api = new FakeCceApi([fullAutomation('auto_1') as never]);

  const report = await upsertAutomations(api.asHttpClient(), [
    { id: 'auto_1', trigger: null } as unknown as AutomationInput,
  ]);

  assert.equal(api.calls.length, 0, 'no salió ni una petición');
  assert.match(report.failed?.message ?? '', /"trigger" en null/);
  assert.match(report.failed?.message ?? '', /la config queda rota/);
  assert.equal(report.failed?.stateUnknown, false);
});

test('el daño que evita ese guard: un PATCH con trigger:null rompe TODA lectura', async () => {
  // Sin el chequeo local esto es lo que pasaba: `PatchAutomationDto` declara
  // todo `@IsOptional()` y class-validator saltea la validación en null, así
  // que la API guarda (con fsync) y recién después `projectAutomation` explota.
  const api = new FakeCceApi([fullAutomation('auto_1') as never]);

  const patch = api.handle('PATCH', '/api/config/automations/auto_1', { trigger: null });
  assert.equal(patch.status, 200, 'la API lo ACEPTA');

  const get = api.handle('GET', '/api/config/automations');
  assert.equal(get.status, 500, 'y desde ahí toda lectura falla');
});

test('create: una clave mal tipeada NO se manda — la whitelist la borraría en silencio', async () => {
  const api = new FakeCceApi([fullAutomation('auto_1') as never]);
  const conTypo = {
    ...fullAutomation('auto_1', { name: 'renombrada' }),
    triger: { type: 'schedule', time: '19:00' },
  } as unknown as AutomationInput;
  delete (conTypo as Record<string, unknown>).trigger;

  const report = await upsertAutomations(api.asHttpClient(), [conTypo]);

  assert.equal(api.calls.length, 0, 'no salió ni una petición');
  assert.match(report.failed?.message ?? '', /"triger" \(¿"trigger"\?\)/);
  assert.match(report.failed?.message ?? '', /a medio escribir/);
});

test('el daño que evita ese guard: la API guarda el resto sobre el trigger VIEJO', async () => {
  const api = new FakeCceApi([
    fullAutomation('auto_1', { name: 'vieja', trigger: { type: 'manual' } }) as never,
  ]);

  const reply = api.handle('PATCH', '/api/config/automations/auto_1', {
    name: 'nueva',
    triger: { type: 'schedule', time: '19:00' },
  });

  assert.equal(reply.status, 200, 'la API responde 200…');
  assert.equal(api.automations[0].name, 'nueva');
  assert.deepEqual(api.automations[0].trigger, { type: 'manual' }, '…con el trigger viejo');
});

test('create: un item que sólo trae id no gatilla un commit vacío', async () => {
  const api = new FakeCceApi([fullAutomation('auto_1') as never]);

  const report = await upsertAutomations(api.asHttpClient(), [
    { id: 'auto_1' } as AutomationInput,
  ]);

  assert.equal(api.calls.length, 0);
  assert.match(report.failed?.message ?? '', /sólo trae "id"/);
});

test('create: el rechazo local corta el archivo como cualquier otro error', async () => {
  const api = new FakeCceApi([]);

  const report = await upsertAutomations(api.asHttpClient(), [
    fullAutomation('auto_a') as AutomationInput,
    { id: 'auto_b', enabeld: false } as unknown as AutomationInput,
    fullAutomation('auto_c') as AutomationInput,
  ]);

  assert.deepEqual(report.applied.map((o) => o.id), ['auto_a']);
  assert.match(report.failed?.message ?? '', /"enabeld" \(¿"enabled"\?\)/);
  assert.deepEqual(report.notAttempted, ['auto_c']);
});

// ── 5xx: el estado también queda en duda ──────────────────────────────────

test('un 5xx puede llegar DESPUÉS del commit: es estado desconocido', async () => {
  const { client } = fakeHttp(() => {
    throw nestError(502, { message: 'Bad Gateway', error: 'Bad Gateway', statusCode: 502 });
  });

  const report = await upsertAutomations(client, [auto()]);

  assert.equal(report.failed?.stateUnknown, true);
  assert.equal(retryIsSafe(report), false);
});

test('un 4xx no lo es: la API rechazó antes de escribir', async () => {
  const { client } = fakeHttp(() => {
    throw validationError('name should not be empty');
  });

  const report = await upsertAutomations(client, [auto()]);

  assert.equal(report.failed?.stateUnknown, false);
});
