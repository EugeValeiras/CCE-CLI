import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, TransportError, apiErrorMessage } from '../src/lib/api-client.js';
import {
  AutomationInput,
  AutomationsHttp,
  HttpResponse,
  deleteAutomation,
  derivedFlowWarnings,
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

test('create: si el POST no devuelve el id, se corta en vez de reportar un id vacío', async () => {
  const { client } = fakeHttp(() => ({ data: { success: true } }));

  const report = await upsertAutomations(client, [auto()]);

  assert.equal(report.applied.length, 0);
  assert.match(report.failed?.message ?? '', /no devolvió el id/);
});

// ── create: el contrato real (doble que valida como la API) ───────────────

test('create: un PARCHE PARCIAL sobre algo existente se aplica, aunque el POST lo rechace', async () => {
  // El caso que el fake complaciente daba por bueno: el ValidationPipe corre
  // ANTES del handler, así que `{id, enabled:false}` NUNCA llega al 409 —
  // se lleva un 400 por name/trigger/actions faltantes.
  const api = new FakeCceApi([fullAutomation('auto_1', { enabled: true }) as never]);

  const report = await upsertAutomations(api.asHttpClient(), [
    { id: 'auto_1', enabled: false } as AutomationInput,
  ]);

  assert.deepEqual(
    api.calls.map((c) => `${c.method} ${c.path}`),
    ['POST /api/config/automations', 'PATCH /api/config/automations/auto_1'],
  );
  assert.equal(report.failed, undefined, report.failed?.message);
  assert.equal(report.applied[0].action, 'updated');
  assert.equal(api.automations[0].enabled, false);
  // Y el merge es top-level: lo que el parche no trae, queda.
  assert.equal(api.automations[0].name, 'auto auto_1');
});

test('create: un body incompleto para algo que NO existe reporta el error del POST, no «no existe»', async () => {
  const api = new FakeCceApi([]);

  const report = await upsertAutomations(api.asHttpClient(), [
    { id: 'auto_nueva', enabled: false } as AutomationInput,
  ]);

  // Intenta el PATCH (por si existía), se lleva un 404, y reporta el 400
  // original: el problema real es que el body no alcanza para CREAR.
  assert.deepEqual(
    api.calls.map((c) => c.method),
    ['POST', 'PATCH'],
  );
  assert.match(report.failed?.message ?? '', /name must be a string|name should not be empty/);
  assert.doesNotMatch(report.failed?.message ?? '', /No existe la automatización/);
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

test('create: avisa que la API descarta flow/when en los items flowDerived', async () => {
  const api = new FakeCceApi([fullAutomation('auto_1') as never]);

  const report = await upsertAutomations(api.asHttpClient(), [exportada('auto_1')]);

  assert.equal(report.applied[0].action, 'updated');
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /flowDerived/);
  // Y el doble confirma el descarte: el flujo editado no se guardó.
  assert.equal(api.automations[0].flow, undefined);
});

test('create: el aviso de flowDerived NO habla de items que nunca se enviaron', async () => {
  const api = new FakeCceApi([]);

  const report = await upsertAutomations(api.asHttpClient(), [
    exportada('auto_enviada'),
    // Corta acá: sin name no se puede crear NI parchear.
    { id: 'auto_corta', name: '' } as AutomationInput,
    exportada('auto_nunca_enviada'),
  ]);

  assert.equal(report.failed?.label, 'auto_corta');
  assert.match(report.warnings[0], /auto_enviada/);
  assert.doesNotMatch(report.warnings[0], /auto_nunca_enviada/);
});

test('sin flowDerived (o sin flow) no hay aviso', async () => {
  assert.deepEqual(derivedFlowWarnings([auto('auto_1')]), []);
  assert.deepEqual(
    derivedFlowWarnings([fullAutomation('auto_1', { flowDerived: true }) as AutomationInput]),
    [],
  );
  assert.equal(derivedFlowWarnings([exportada('auto_1')]).length, 1);
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
  assert.ok(new TransportError('x', 'ECONNRESET') instanceof Error);
  assert.ok(!(new TransportError('x', 'ECONNRESET') instanceof ApiError));
});
