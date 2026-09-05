import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, apiErrorMessage } from '../src/lib/api-client.js';
import {
  AutomationInput,
  AutomationsHttp,
  HttpResponse,
  deleteAutomation,
  replaceAllAutomations,
  retryIsSafe,
  setAutomationEnabled,
  upsertAutomations,
} from '../src/lib/automations-api.js';

/**
 * CCE#107 — Lo que estos tests afirman es MÉTODO y RUTA.
 *
 * El bug que cierra este issue no era un cálculo mal hecho sino una forma de
 * escribir: `PUT /config/automations` con el array entero pisaba lo que otro
 * cliente hubiera escrito en el medio. Por eso cada caso mira la lista de
 * llamadas que salieron —y varios afirman lo que NO salió: ningún camino
 * item-level puede volver a mandar un PUT del array.
 *
 * Los errores de los fakes se arman con `apiErrorMessage`, el mismo que usa el
 * interceptor real, sobre cuerpos calcados de la API. Una versión anterior de
 * este suite inventaba mensajes que el CLI nunca producía y así validaba una
 * calidad de diagnóstico inexistente; ver `api-client.test.ts`.
 */

interface Call {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
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
    get: <T>(url: string, config?: unknown) =>
      record<T>({ method: 'GET', url, headers: sentHeaders(config) }),
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

/** La respuesta real de POST /api/config/automations. */
const created = (id: string): HttpResponse<unknown> => ({
  data: { success: true, automation: { id }, version: 621 },
});

const auto = (id?: string): AutomationInput =>
  ({ ...(id ? { id } : {}), name: `auto ${id ?? 'sin id'}`, enabled: true }) as AutomationInput;

// ── create ────────────────────────────────────────────────────────────────

test('create: una automatización nueva sale por POST y nada más', async () => {
  const { client, calls } = fakeHttp(() => created('auto_nueva'));

  const report = await upsertAutomations(client, [auto('auto_nueva')]);

  assert.deepEqual(calls, [
    { method: 'POST', url: '/config/automations', body: auto('auto_nueva'), headers: undefined },
  ]);
  assert.deepEqual(report.applied, [
    { id: 'auto_nueva', label: 'auto_nueva', action: 'created', idGeneratedByServer: false },
  ]);
  assert.equal(report.failed, undefined);
});

test('create: sin id, el id que reporta es el que generó la API', async () => {
  const { client, calls } = fakeHttp(() => created('auto_generado_por_el_server'));

  const report = await upsertAutomations(client, [auto()]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(report.applied, [
    {
      id: 'auto_generado_por_el_server',
      label: '«auto sin id»',
      action: 'created',
      idGeneratedByServer: true,
    },
  ]);
});

test('create: un id que ya existe cae al PATCH del item y se reporta como actualizada', async () => {
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
  assert.deepEqual(calls[1].body, { name: 'auto auto_vieja', enabled: true });
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

test('create: distingue creadas de actualizadas en la misma corrida', async () => {
  const { client } = fakeHttp((call) => {
    if (call.method === 'POST') {
      const id = (call.body as { id: string }).id;
      if (id === 'auto_b') throw conflict(id);
      return created(id);
    }
    return OK;
  });

  const report = await upsertAutomations(client, [auto('auto_a'), auto('auto_b')]);

  assert.deepEqual(
    report.applied.map((o) => `${o.id}:${o.action}`),
    ['auto_a:created', 'auto_b:updated'],
  );
});

test('create: el POST va PRIMERO — una alta nunca pasa por el DTO angosto del PATCH', async () => {
  // No es un detalle de orden: `PatchAutomationDto` valida más angosto que el
  // del POST (EugeValeiras/CCE#109), así que un PATCH-first haría fallar con
  // 400 altas perfectamente válidas. sourceAction 'toggle' es una de ellas.
  const conToggle = {
    ...auto('auto_grupo'),
    source: 'group',
    sourceAction: 'toggle',
  } as unknown as AutomationInput;
  const { client, calls } = fakeHttp((call) => {
    if (call.method === 'PATCH') throw validationError('sourceAction must be one of: on, off');
    return created('auto_grupo');
  });

  const report = await upsertAutomations(client, [conToggle]);

  assert.deepEqual(
    calls.map((c) => c.method),
    ['POST'],
  );
  assert.equal(report.failed, undefined);
  assert.equal(report.applied[0].action, 'created');
});

test('create: un 400 del PATCH avisa que puede ser el DTO angosto de la API, no el archivo', async () => {
  const { client } = fakeHttp((call) => {
    if (call.method === 'POST') throw conflict('auto_grupo');
    throw validationError('sourceAction must be one of the following values: on, off');
  });

  const report = await upsertAutomations(client, [auto('auto_grupo')]);

  // El mensaje de la API, entero…
  assert.match(report.failed?.message ?? '', /sourceAction must be one of/);
  // …y la pista de que el body puede estar bien.
  assert.match(report.failed?.message ?? '', /EugeValeiras\/CCE#109/);
});

test('create: un error que no es 409 corta ahí y NO se intenta el resto (fail-fast)', async () => {
  const { client, calls } = fakeHttp((call) => {
    const id = (call.body as { id: string }).id;
    if (id === 'auto_b') throw validationError('name should not be empty');
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
  assert.deepEqual(report.failed, {
    label: 'auto_b',
    message: 'HTTP 400: name should not be empty',
  });
  assert.deepEqual(report.notAttempted, ['auto_c']);
  // auto_c no se tocó: dos POST (auto_a y el fallido auto_b) y se acabó.
  assert.equal(calls.length, 2);
  assert.ok(!calls.some((c) => JSON.stringify(c.body ?? '').includes('auto_c')));
});

test('create: sin id, un 409 no se traduce a PATCH — se reporta como error', async () => {
  const { client, calls } = fakeHttp(() => {
    throw conflict('el que sea');
  });

  const report = await upsertAutomations(client, [auto()]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(report.failed?.label, '«auto sin id»');
});

test('create: si el POST no devuelve el id, se corta en vez de reportar un id vacío', async () => {
  const { client } = fakeHttp(() => ({ data: { success: true } }));

  const report = await upsertAutomations(client, [auto()]);

  assert.equal(report.applied.length, 0);
  assert.match(report.failed?.message ?? '', /no devolvió el id/);
});

test('create: ningún camino manda el PUT masivo ni relee el array entero', async () => {
  const { client, calls } = fakeHttp((call) => {
    if (call.method === 'POST') throw conflict('auto_x');
    return OK;
  });

  await upsertAutomations(client, [auto('auto_x'), auto('auto_y')]);

  assert.ok(!calls.some((c) => c.method === 'PUT'));
  assert.ok(!calls.some((c) => c.method === 'GET'));
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

  // El mismo archivo pero con el primer item SIN id: reaplicarlo lo crearía de
  // nuevo con OTRO id — dos automatizaciones idénticas sobre el mismo trigger.
  const sinId = await upsertAutomations(client, [auto(), auto('auto_malo')]);
  assert.equal(retryIsSafe(sinId), false);
  assert.equal(sinId.applied[0].idGeneratedByServer, true);
  assert.equal(sinId.applied[0].label, '«auto sin id»');
  assert.equal(sinId.applied[0].id, 'auto_acuñado_por_el_server');
});

test('reintentar es seguro cuando no se aplicó nada', async () => {
  const { client } = fakeHttp(() => {
    throw validationError('name should not be empty');
  });

  const report = await upsertAutomations(client, [auto('auto_a')]);

  assert.equal(report.applied.length, 0);
  assert.equal(retryIsSafe(report), true);
});

// ── flowDerived: el no-op silencioso ──────────────────────────────────────

test('create: avisa que la API descarta flow/when en los items flowDerived', async () => {
  const exportada = {
    ...auto('auto_1'),
    flowDerived: true,
    flow: [{ type: 'do', actions: [] }],
    when: [{ type: 'manual' }],
  } as unknown as AutomationInput;
  const { client } = fakeHttp((call) => {
    if (call.method === 'POST') throw conflict('auto_1');
    return OK;
  });

  const report = await upsertAutomations(client, [exportada]);

  // La escritura "funciona" (200) pero flow/when no se persisten: sin este
  // aviso el CLI imprimía «✓ Actualizadas» sobre un cambio que no ocurrió.
  assert.equal(report.applied[0].action, 'updated');
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /flowDerived/);
  assert.match(report.warnings[0], /auto_1/);
  assert.match(report.warnings[0], /quitá "flowDerived"/);
});

test('create: sin flowDerived (o sin flow) no hay aviso', async () => {
  const { client } = fakeHttp(() => created('auto_1'));

  const conFlow = await upsertAutomations(client, [
    { ...auto('auto_1'), flow: [{ type: 'stop' }] } as unknown as AutomationInput,
  ]);
  assert.deepEqual(conFlow.warnings, []);

  // flowDerived:true pero sin flow ni when: no hay nada que la API descarte.
  const soloMarca = await upsertAutomations(client, [
    { ...auto('auto_1'), flowDerived: true } as unknown as AutomationInput,
  ]);
  assert.deepEqual(soloMarca.warnings, []);
});

// ── delete ────────────────────────────────────────────────────────────────

test('delete: un DELETE al item, sin GET previo ni PUT del array', async () => {
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

// ── enable / disable ──────────────────────────────────────────────────────

test('enable: PATCH del item con {enabled:true} y nada del array', async () => {
  const { client, calls } = fakeHttp();

  await setAutomationEnabled(client, 'auto_1', true);

  assert.deepEqual(calls, [
    {
      method: 'PATCH',
      url: '/config/automations/auto_1',
      body: { enabled: true },
      headers: undefined,
    },
  ]);
});

test('disable: mismo PATCH con {enabled:false}', async () => {
  const { client, calls } = fakeHttp();

  await setAutomationEnabled(client, 'auto_1', false);

  assert.deepEqual(calls[0].body, { enabled: false });
  assert.ok(!calls.some((c) => c.method === 'GET' || c.method === 'PUT'));
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

test('replace masivo: manda el If-Match que le dieron y NO lee la versión por su cuenta', async () => {
  const { client, calls } = fakeHttp();

  await replaceAllAutomations(client, [auto('auto_1')], '620');

  // El GET propio es justamente lo que NO puede haber: la versión tiene que
  // venir de la lectura que el usuario editó, no de una de recién.
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
  // El dueño exportó en la versión 620; la App creó una automatización
  // (→ 621) mientras él editaba. Su archivo NO la tiene.
  const array = [auto('auto_1')];
  let serverVersion = 620;
  const { client } = fakeHttp((call) => {
    const sent = call.headers?.['If-Match'];
    if (Number(sent) !== serverVersion) throw staleError(String(sent), serverVersion);
    array.length = 0;
    array.push(...(call.body as AutomationInput[]));
    serverVersion++;
    return OK;
  });
  array.push(auto('auto_de_la_app'));
  serverVersion = 621;

  // Reescribe con la versión en la que SE BASÓ la edición: la API lo frena.
  await assert.rejects(
    () => replaceAllAutomations(client, [auto('auto_1')], '620'),
    /cambió desde la versión 620/,
  );
  assert.ok(
    array.some((a) => a.id === 'auto_de_la_app'),
    'el replace masivo borró la automatización que había creado la App',
  );
});

// ── el criterio que da sentido al issue ───────────────────────────────────

/**
 * Un servidor con estado, en lo mínimo: guarda el array y aplica POST/PATCH
 * sobre UN item, o el PUT masivo pisando TODO (como lo hacía el CLI viejo).
 *
 * `afterCall` corre después de CADA llamada —GET incluido— y es por dónde se
 * cuela la escritura ajena que simula a la App o el Dashboard. Que el hook
 * cuente llamadas y no escrituras es lo que hace honesto al test: la ventana
 * peligrosa del patrón viejo se abre justo después del GET.
 */
function statefulApi(
  initial: AutomationInput[],
  afterCall?: (nth: number, state: AutomationInput[]) => void,
) {
  const state = [...initial];
  let nth = 0;
  const handle = (call: Call): HttpResponse<unknown> => {
    if (call.method === 'GET') {
      return { data: [...state], headers: { 'x-config-version': String(nth) } };
    }
    if (call.method === 'POST') {
      const body = call.body as AutomationInput;
      const id = String(body.id ?? `auto_gen_${state.length}`);
      if (state.some((a) => a.id === id)) throw conflict(id);
      state.push({ ...body, id });
      return { data: { success: true, automation: { id }, version: nth } };
    }
    if (call.method === 'PATCH') {
      const id = decodeURIComponent(call.url.split('/').pop() as string);
      const i = state.findIndex((a) => a.id === id);
      if (i === -1) throw notFound(id);
      state[i] = { ...state[i], ...(call.body as AutomationInput) };
      return OK;
    }
    if (call.method === 'DELETE') {
      const id = decodeURIComponent(call.url.split('/').pop() as string);
      const i = state.findIndex((a) => a.id === id);
      if (i === -1) throw notFound(id);
      state.splice(i, 1);
      return OK;
    }
    if (call.method === 'PUT') {
      // El replace masivo tal como era: lo que el cliente no traiga, muere.
      state.length = 0;
      state.push(...(call.body as AutomationInput[]));
      return OK;
    }
    return OK;
  };
  const { client, calls } = fakeHttp((call) => {
    try {
      return handle(call);
    } finally {
      afterCall?.(++nth, state);
    }
  });
  return { client, calls, state };
}

test('create: una automatización creada por otra vía EN EL MEDIO sigue existiendo al terminar', async () => {
  // La ajena entra después de la primera llamada del CLI. Con el patrón viejo
  // esa primera llamada era el GET y la segunda el PUT del array leído antes:
  // la ajena moría ahí. Con item-level no hay array que reenviar, así que
  // sobrevive — y si alguien vuelve al GET+PUT, este test se cae.
  const { client, state } = statefulApi([auto('auto_ya_estaba')], (nth, s) => {
    if (nth === 1) s.push(auto('auto_de_la_app'));
  });

  const report = await upsertAutomations(client, [auto('auto_del_cli_1'), auto('auto_del_cli_2')]);

  assert.equal(report.failed, undefined);
  assert.deepEqual(
    state.map((a) => a.id),
    ['auto_ya_estaba', 'auto_del_cli_1', 'auto_de_la_app', 'auto_del_cli_2'],
  );
});

test('enable: cambiar un booleano no puede pisar una escritura ajena ni a las vecinas', async () => {
  const { client, state } = statefulApi([auto('auto_1'), auto('auto_2')], (nth, s) => {
    if (nth === 1) s.push(auto('auto_de_la_app'));
  });

  await setAutomationEnabled(client, 'auto_1', false);

  assert.equal(state.find((a) => a.id === 'auto_1')?.enabled, false);
  assert.equal(state.find((a) => a.id === 'auto_2')?.enabled, true);
  assert.ok(
    state.some((a) => a.id === 'auto_de_la_app'),
    'se perdió la escritura ajena',
  );
});

test('delete: borrar una no puede pisar una escritura ajena', async () => {
  const { client, state } = statefulApi([auto('auto_1'), auto('auto_2')], (nth, s) => {
    if (nth === 1) s.push(auto('auto_de_la_app'));
  });

  await deleteAutomation(client, 'auto_1');

  assert.deepEqual(
    state.map((a) => a.id),
    ['auto_2', 'auto_de_la_app'],
  );
});
