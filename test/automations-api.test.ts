import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../src/lib/api-client.js';
import {
  AutomationInput,
  AutomationsHttp,
  HttpResponse,
  deleteAutomation,
  replaceAllAutomations,
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

/** La respuesta real de POST /api/config/automations. */
const created = (id: string): HttpResponse<unknown> => ({
  data: { success: true, automation: { id }, version: 621 },
});

const conflict = (id: string): ApiError =>
  new ApiError(`HTTP 409: Ya existe una automatización con id ${id}`, 409);

const auto = (id?: string): AutomationInput =>
  ({ ...(id ? { id } : {}), name: `auto ${id ?? 'sin id'}`, enabled: true }) as AutomationInput;

// ── create ────────────────────────────────────────────────────────────────

test('create: una automatización nueva sale por POST y nada más', async () => {
  const { client, calls } = fakeHttp(() => created('auto_nueva'));

  const report = await upsertAutomations(client, [auto('auto_nueva')]);

  assert.deepEqual(calls, [
    { method: 'POST', url: '/config/automations', body: auto('auto_nueva'), headers: undefined },
  ]);
  assert.deepEqual(report.applied, [{ id: 'auto_nueva', action: 'created' }]);
  assert.equal(report.failed, undefined);
});

test('create: sin id, el id que reporta es el que generó la API', async () => {
  const { client, calls } = fakeHttp(() => created('auto_generado_por_el_server'));

  const report = await upsertAutomations(client, [auto()]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(report.applied, [
    { id: 'auto_generado_por_el_server', action: 'created' },
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
  assert.deepEqual(report.applied, [{ id: 'auto_vieja', action: 'updated' }]);
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

  assert.deepEqual(report.applied, [
    { id: 'auto_a', action: 'created' },
    { id: 'auto_b', action: 'updated' },
  ]);
});

test('create: un error que no es 409 corta ahí y NO se intenta el resto (fail-fast)', async () => {
  const { client, calls } = fakeHttp((call) => {
    const id = (call.body as { id: string }).id;
    if (id === 'auto_b') throw new ApiError('HTTP 400: Flujo inválido en flow[0].then', 400);
    return created(id);
  });

  const report = await upsertAutomations(client, [
    auto('auto_a'),
    auto('auto_b'),
    auto('auto_c'),
  ]);

  assert.deepEqual(report.applied, [{ id: 'auto_a', action: 'created' }]);
  assert.deepEqual(report.failed, {
    label: 'auto_b',
    message: 'HTTP 400: Flujo inválido en flow[0].then',
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

test('create: ningún camino manda el PUT masivo ni relee el array entero', async () => {
  const { client, calls } = fakeHttp((call) => {
    if (call.method === 'POST') throw conflict('auto_x');
    return OK;
  });

  await upsertAutomations(client, [auto('auto_x'), auto('auto_y')]);

  assert.ok(!calls.some((c) => c.method === 'PUT'));
  assert.ok(!calls.some((c) => c.method === 'GET'));
});

// ── delete ────────────────────────────────────────────────────────────────

test('delete: un DELETE al item, sin GET previo ni PUT del array', async () => {
  const { client, calls } = fakeHttp();

  await deleteAutomation(client, 'auto_1');

  assert.deepEqual(calls, [
    { method: 'DELETE', url: '/config/automations/auto_1', headers: undefined },
  ]);
});

test('delete: un id inexistente propaga el 404 de la API', async () => {
  const { client } = fakeHttp(() => {
    throw new ApiError('HTTP 404: No existe la automatización auto_fantasma', 404);
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

test('enable: un id inexistente propaga el 404 de la API', async () => {
  const { client } = fakeHttp(() => {
    throw new ApiError('HTTP 404: No existe la automatización auto_fantasma', 404);
  });

  await assert.rejects(
    () => setAutomationEnabled(client, 'auto_fantasma', true),
    /HTTP 404/,
  );
});

// ── replace masivo (config set-remote automations) ────────────────────────

test('replace masivo: manda If-Match con la versión del GET', async () => {
  const { client, calls } = fakeHttp((call) =>
    call.method === 'GET' ? { data: [], headers: { 'x-config-version': '620' } } : OK,
  );

  await replaceAllAutomations(client, [auto('auto_1')]);

  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.url}`),
    ['GET /config/automations', 'PUT /config/automations'],
  );
  assert.deepEqual(calls[1].headers, { 'If-Match': '620' });
});

test('replace masivo: sin X-Config-Version no se envía el PUT', async () => {
  const { client, calls } = fakeHttp(() => ({ data: [], headers: {} }));

  await assert.rejects(
    () => replaceAllAutomations(client, []),
    /X-Config-Version/,
  );
  assert.ok(!calls.some((c) => c.method === 'PUT'));
});

test('replace masivo: el 409 se traduce a un mensaje accionable', async () => {
  const { client } = fakeHttp((call) => {
    if (call.method === 'GET') return { data: [], headers: { 'x-config-version': '620' } };
    throw new ApiError('HTTP 409: Config de automations stale', 409);
  });

  await assert.rejects(() => replaceAllAutomations(client, []), (e: Error) => {
    assert.match(e.message, /cambió mientras editabas \(tu versión: 620\)/);
    assert.match(e.message, /No se escribió nada/);
    return true;
  });
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
      if (i === -1) throw new ApiError(`HTTP 404: No existe la automatización ${id}`, 404);
      state[i] = { ...state[i], ...(call.body as AutomationInput) };
      return OK;
    }
    if (call.method === 'DELETE') {
      const id = decodeURIComponent(call.url.split('/').pop() as string);
      const i = state.findIndex((a) => a.id === id);
      if (i === -1) throw new ApiError(`HTTP 404: No existe la automatización ${id}`, 404);
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
  assert.deepEqual(state.map((a) => a.id), [
    'auto_ya_estaba',
    'auto_del_cli_1',
    'auto_de_la_app',
    'auto_del_cli_2',
  ]);
});

test('enable: cambiar un booleano no puede pisar una escritura ajena ni a las vecinas', async () => {
  const { client, state } = statefulApi([auto('auto_1'), auto('auto_2')], (nth, s) => {
    if (nth === 1) s.push(auto('auto_de_la_app'));
  });

  await setAutomationEnabled(client, 'auto_1', false);

  assert.equal(state.find((a) => a.id === 'auto_1')?.enabled, false);
  assert.equal(state.find((a) => a.id === 'auto_2')?.enabled, true);
  assert.ok(state.some((a) => a.id === 'auto_de_la_app'), 'se perdió la escritura ajena');
});

test('delete: borrar una no puede pisar una escritura ajena', async () => {
  const { client, state } = statefulApi([auto('auto_1'), auto('auto_2')], (nth, s) => {
    if (nth === 1) s.push(auto('auto_de_la_app'));
  });

  await deleteAutomation(client, 'auto_1');

  assert.deepEqual(state.map((a) => a.id), ['auto_2', 'auto_de_la_app']);
});
