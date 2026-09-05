import { Automation } from '../types/api.js';
import { ApiError, UnknownStateError, isApiError, isUnknownState } from './api-client.js';

/**
 * CCE#107 — Las escrituras de automatizaciones, item por item.
 *
 * Hasta acá los tres comandos que escriben (create/delete/enable-disable)
 * hacían lo mismo: GET del array ENTERO, merge en memoria, PUT del array
 * ENTERO. Entre el GET y el PUT hay una ventana de ~1 s en la que cualquier
 * escritura desde la App o el Dashboard queda pisada EN SILENCIO — el vector
 * del incidente del 2026-06-10, y el motivo de que la API deje un WARN de
 * deprecación en el journal por cada uno de esos PUT.
 *
 * Los endpoints item-level (POST/PATCH/DELETE) no pueden pisar al resto del
 * array por construcción: la API toca UNA automatización y deja las otras 21
 * como estén. Por eso `AutomationsHttp` ni siquiera declara `get`: que no haya
 * forma de leer el array desde acá hace que el read-modify-write no pueda
 * volver por descuido — el compilador lo impide.
 *
 * La lógica vive separada de `commands/automations.ts` para que sea testeable
 * con un cliente HTTP falso: lo que hay que poder afirmar de estas operaciones
 * es el método y la ruta que mandan, no lo que imprimen.
 */

/** Una respuesta HTTP, en lo mínimo que estas operaciones miran. */
export interface HttpResponse<T = unknown> {
  data: T;
}

/**
 * Lo mínimo que estas operaciones necesitan de un cliente HTTP — sin `get`, a
 * propósito (ver arriba). Un `AxiosInstance` lo cumple; un objeto de test que
 * registra método y ruta, también.
 */
export interface AutomationsHttp {
  post<T = unknown>(url: string, body?: unknown, config?: unknown): Promise<HttpResponse<T>>;
  patch<T = unknown>(url: string, body?: unknown, config?: unknown): Promise<HttpResponse<T>>;
  put<T = unknown>(url: string, body?: unknown, config?: unknown): Promise<HttpResponse<T>>;
  delete<T = unknown>(url: string, config?: unknown): Promise<HttpResponse<T>>;
}

/**
 * Lo que trae el archivo de `create`. El id es opcional: sin id, la API genera
 * uno y lo devuelve.
 */
export type AutomationInput = Partial<Automation> & Record<string, unknown>;

interface CreateAutomationResponse {
  success: boolean;
  automation: Automation;
  version: number;
}

export interface UpsertOutcome {
  /** El id definitivo: el del archivo, o el que generó la API. */
  id: string;
  /** Cómo lo nombraba el archivo, para poder mapearlo cuando el id lo puso la API. */
  label: string;
  action: 'created' | 'updated';
  /**
   * true si el archivo NO traía id y lo acuñó el server. Estos items son los
   * únicos que NO son re-aplicables: ver `retryIsSafe`.
   */
  idGeneratedByServer: boolean;
}

export interface UpsertFailure {
  label: string;
  message: string;
  /** Si el archivo traía id para este item. */
  hadId: boolean;
  /**
   * true cuando no se puede afirmar que la escritura NO ocurrió: la respuesta
   * se perdió, o el 5xx llegó después del commit. Ver `isUnknownState`.
   */
  stateUnknown: boolean;
}

/**
 * Qué pasó con un `create` de N automatizaciones.
 *
 * ATOMICIDAD (decisión de CCE#107): item por item ya no hay "todo o nada", así
 * que el corte es FAIL-FAST — al primer error se aborta y no se intenta lo que
 * queda. El motivo es que un archivo con varias automatizaciones casi siempre
 * describe UN cambio coherente (el "modo movimiento" de la casa son dos
 * automatizaciones que no pueden quedar desparejas), y seguir empujando sobre
 * un error deja un estado a mitad de camino más difícil de razonar que uno
 * cortado en un punto conocido. Además el primer error suele ser sistémico
 * (401, API caída): insistir sólo multiplica el ruido.
 *
 * Lo que NO puede pasar —y por eso este reporte existe— es que falle en
 * silencio: `applied` dice qué quedó escrito, `failed` en cuál cortó, por qué y
 * si el estado quedó en duda, `notAttempted` qué ni se intentó, y `warnings` lo
 * que se mandó distinto de lo que el archivo pedía.
 */
export interface UpsertReport {
  applied: UpsertOutcome[];
  failed?: UpsertFailure;
  notAttempted: string[];
  warnings: string[];
}

/** Cómo nombrar una automatización del archivo en un mensaje. */
export function labelOf(item: AutomationInput): string {
  if (typeof item?.id === 'string' && item.id) return item.id;
  if (typeof item?.name === 'string' && item.name) return `«${item.name}»`;
  return '(sin id ni nombre)';
}

/**
 * Si reaplicar el archivo entero después de un fallo es seguro.
 *
 * El upsert es idempotente SÓLO para items con id: ahí el segundo intento
 * encuentra el existente y lo actualiza. Un item SIN id no lo es — cada POST
 * acuña un id nuevo, así que reaplicar crea un DUPLICADO de lo que ya entró, y
 * la casa queda con dos automatizaciones idénticas disparando sobre el mismo
 * trigger.
 *
 * Un corte sin respuesta sobre un item SIN id cae en la misma trampa: no se
 * sabe si entró, así que reintentar puede duplicarlo igual.
 */
export function retryIsSafe(report: UpsertReport): boolean {
  if (report.applied.some((o) => o.idGeneratedByServer)) return false;
  if (report.failed?.stateUnknown && !report.failed.hadId) return false;
  return true;
}

// ── Validación local: lo que la API acepta y después no puede leer ────────

/**
 * Las claves que los DTOs de la API declaran (`AutomationConfig` y
 * `PatchAutomationDto`, `automation.dto.ts`).
 *
 * El ValidationPipe global corre con `whitelist: true` y SIN
 * `forbidNonWhitelisted`: una clave que no esté acá se descarta EN SILENCIO y
 * la escritura sigue adelante con el resto. Un `"triger"` mal tipeado no da
 * error: guarda name/enabled/actions sobre el trigger VIEJO y responde 200.
 * Por eso el CLI corta antes: es la diferencia entre un typo y una
 * automatización a medio escribir.
 */
const KNOWN_KEYS = new Set([
  'id',
  'name',
  'icon',
  'enabled',
  'source',
  'sourceId',
  'sourceAction',
  'sourceSmart',
  'mode',
  'trigger',
  'actions',
  'when',
  'flow',
  'flowDerived',
  'flowLayout',
  'onRetrigger',
  'planId',
  'planIds',
]);

/** Las cuatro que `AutomationConfig` exige para poder CREAR. */
const REQUIRED_TO_CREATE = ['name', 'enabled', 'trigger', 'actions'] as const;

/** Distancia de edición acotada, sólo para sugerir la clave que se quiso escribir. */
function closest(key: string): string | undefined {
  let best: string | undefined;
  let bestDistance = 3; // más lejos que esto ya no es un typo
  for (const known of KNOWN_KEYS) {
    const d = editDistance(key.toLowerCase(), known.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = known;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const previous = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return prev[b.length];
}

/**
 * Lo que hay que rechazar ANTES de mandar, porque la API lo acepta y recién
 * después se rompe.
 *
 *  - `null` en cualquier campo: `PatchAutomationDto` los declara
 *    `@IsOptional()`, y class-validator SALTEA la validación en `null`. Un
 *    `{"trigger": null}` se guarda con fsync y a partir de ahí
 *    `projectAutomation` explota en CADA lectura: la App, el Dashboard y
 *    `cce automations list` reciben 500, el motor de schedules se cae, y en el
 *    próximo reinicio la config no carga. Se arregla editando el
 *    cce-config.json a mano.
 *  - Claves desconocidas: ver `KNOWN_KEYS`.
 *  - Un item que sólo trae `id`: el PATCH vacío igual commitea (bump de
 *    versión, fsync, recarga de motores y broadcast) y se reportaría como
 *    «actualizada» sin haber cambiado nada.
 */
function localRejection(item: AutomationInput): string | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return 'no es un objeto JSON.';
  }
  const keys = Object.keys(item);
  if (!keys.length) return 'está vacío.';
  const unknown = keys.filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length) {
    const hints = unknown.map((k) => {
      const near = closest(k);
      return near ? `"${k}" (¿"${near}"?)` : `"${k}"`;
    });
    return (
      `clave(s) que la API no conoce: ${hints.join(', ')}. Las descartaría en silencio ` +
      '(whitelist) y guardaría el resto, dejando la automatización a medio escribir.'
    );
  }
  const nulls = keys.filter((k) => item[k] === null);
  if (nulls.length) {
    return (
      `${nulls.map((k) => `"${k}"`).join(', ')} en null. La API lo acepta por PATCH y ` +
      'después no puede leer la automatización: la config queda rota para TODOS los ' +
      'clientes. Si querías vaciar el campo, mandá el valor vacío que corresponda.'
    );
  }
  if (keys.length === 1 && keys[0] === 'id') {
    return 'sólo trae "id": no hay nada que escribir.';
  }
  return undefined;
}

/**
 * Crea o actualiza cada automatización del archivo, una por llamada.
 *
 * `create` es UPSERT: hoy el comando se usa para editar automatizaciones
 * existentes desde un archivo —exportar con `show --format json`, editar,
 * volver a aplicar— y convertirlo en error rompería ese flujo.
 *
 * QUÉ MÉTODO SE USA lo decide la FORMA del body, no una respuesta de error:
 *
 *  - sin `id` → POST (la API acuña el id).
 *  - con `id` y las cuatro claves que `AutomationConfig` exige
 *    (`name`/`enabled`/`trigger`/`actions`) → POST y, si responde 409 porque ya
 *    existe, PATCH.
 *  - con `id` y forma parcial → PATCH directo. Un 404 acá es «no existe», que
 *    es exactamente lo que pasó.
 *
 * La versión anterior probaba POST siempre y caía al PATCH ante CUALQUIER 400.
 * Eso convertía al PATCH en un colador: su DTO es todo `@IsOptional()`, así que
 * un body que el POST había rechazado —`trigger: null`, o con una clave mal
 * tipeada que la whitelist descarta— se escribía igual, a medias o dejando la
 * config ilegible. Decidir por la forma cierra las dos puertas, y de paso
 * ahorra el round-trip de más en el camino de edición parcial.
 *
 * Diferencia real respecto del PUT masivo: el PATCH mergea TOP-LEVEL, así que
 * un campo que el archivo NO trae se conserva en vez de borrarse.
 */
export async function upsertAutomations(
  client: AutomationsHttp,
  items: AutomationInput[],
): Promise<UpsertReport> {
  const applied: UpsertOutcome[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < items.length; i++) {
    try {
      applied.push(await upsertOne(client, items[i], warnings));
    } catch (e) {
      return {
        applied,
        failed: {
          label: labelOf(items[i]),
          message: (e as Error).message,
          hadId: Boolean(items[i]?.id),
          stateUnknown: isUnknownState(e),
        },
        notAttempted: items.slice(i + 1).map(labelOf),
        warnings,
      };
    }
  }
  return { applied, notAttempted: [], warnings };
}

/**
 * El flujo derivado se QUITA del envío, no se manda para que la API lo tire.
 *
 * `show --format json` estampa `flowDerived: true` en toda automatización cuyo
 * `flow` es la proyección del formato viejo — en esta casa, todas. La API borra
 * `flow`/`when` de esos bodies (`stripDerivedFlow`) para no persistir un flujo
 * derivado que quedaría stale respecto de `actions`. Mandarlos igual no cambia
 * el resultado y sí invita a creer que se guardaron.
 *
 * El aviso dice lo que PASÓ (se quitaron), no lo que habría que hacer: el
 * consejo anterior —«quitá flowDerived y volvé a aplicar»— es una trampa si
 * además se editaron las `actions`, porque persiste el flujo VIEJO junto a las
 * acciones nuevas y el motor corre uno mientras las UIs muestran las otras.
 */
function stripDerivedFlow(item: AutomationInput, warnings: string[]): AutomationInput {
  if (item.flowDerived !== true) return item;
  const { flow, when, flowDerived, ...rest } = item;
  if (flow === undefined && when === undefined) return rest;
  const aviso =
    'Los items marcados "flowDerived": true llevan el flujo PROYECTADO por la API, no ' +
    'uno propio: se quitaron "flow"/"when" del envío porque la API los descarta igual ' +
    '(el resto del item sí se guarda). Para escribir un flujo propio hay que mandarlo ' +
    'sin la marca Y con las "actions" que le correspondan — si no, el motor corre el ' +
    'flujo y las UIs muestran las actions.';
  if (!warnings.includes(aviso)) warnings.push(aviso);
  return rest;
}

async function upsertOne(
  client: AutomationsHttp,
  item: AutomationInput,
  warnings: string[],
): Promise<UpsertOutcome> {
  const label = labelOf(item);
  const rejection = localRejection(item);
  if (rejection) throw new Error(`${rejection} No se mandó nada.`);

  const body = stripDerivedFlow(item, warnings);
  const id = typeof body.id === 'string' ? body.id : '';
  const creatable = REQUIRED_TO_CREATE.every((k) => body[k] !== undefined);

  if (!id || creatable) {
    try {
      return await create(client, body, id, label);
    } catch (e) {
      // El 409 es la respuesta esperable de un upsert sobre algo que ya
      // existe. Cualquier otro error es del caller: NO se prueba otra vía.
      if (!id || !isApiError(e, 409)) throw e;
    }
  }
  const { id: _path, ...patch } = body;
  try {
    await client.patch(`/config/automations/${encodeURIComponent(id)}`, patch);
  } catch (e) {
    throw explainPatchRejection(e, patch);
  }
  return { id, label, action: 'updated', idGeneratedByServer: false };
}

async function create(
  client: AutomationsHttp,
  body: AutomationInput,
  id: string,
  label: string,
): Promise<UpsertOutcome> {
  const { data } = await client.post<CreateAutomationResponse>('/config/automations', body);
  const assignedId = data?.automation?.id ?? id;
  if (!assignedId) {
    // La API respondió 2xx: la automatización EXISTE, sólo que no sabemos con
    // qué id. Es estado desconocido, no un fallo limpio.
    throw new UnknownStateError(
      'La API aceptó el POST (la automatización se creó) pero no devolvió su id. ' +
        'Buscala con `cce automations list` antes de volver a aplicar el archivo.',
    );
  }
  return { id: assignedId, label, action: 'created', idGeneratedByServer: !id };
}

/**
 * El 400 del PATCH sobre un valor que el DTO ancho SÍ acepta no es culpa del
 * archivo.
 *
 * `PatchAutomationDto` valida más angosto que el de POST/PUT: hoy
 * `sourceAction: 'toggle'` —una forma que la API soporta a propósito y que el
 * PUT masivo aceptaba— da 400 por esta vía. Es un bug de la API
 * (EugeValeiras/CCE#109) que el CLI no puede arreglar, pero sí puede evitar que
 * se lea como «tenés el archivo mal» y que el arreglo natural (cambiar el
 * valor) altere lo que hace la automatización sin que nadie lo note.
 */
function explainPatchRejection(e: unknown, body: AutomationInput): unknown {
  if (!isApiError(e, 400)) return e;
  if (body.sourceAction !== 'toggle' || !/sourceAction/i.test(e.message)) return e;
  return new ApiError(
    `${e.message} — pero 'toggle' ES válido para esta API: el DTO del PATCH valida más ` +
      'angosto que el del POST/PUT. NO lo cambies a on/off (cambiarías lo que hace la ' +
      'automatización): ver EugeValeiras/CCE#109.',
    e.status,
    e.data,
  );
}

/**
 * Borra UNA automatización. El 404 de la API reemplaza al chequeo local previo
 * (traer el array y comparar longitudes): el server es el único que sabe qué
 * hay en el momento del borrado.
 */
export async function deleteAutomation(client: AutomationsHttp, id: string): Promise<void> {
  await client.delete(`/config/automations/${encodeURIComponent(id)}`);
}

/** Habilita/deshabilita UNA automatización: un PATCH de un booleano. */
export async function setAutomationEnabled(
  client: AutomationsHttp,
  id: string,
  enabled: boolean,
): Promise<void> {
  await client.patch(`/config/automations/${encodeURIComponent(id)}`, { enabled });
}

/** La versión de la config de automations que expone el GET, si viene. */
export function readConfigVersion(headers?: Record<string, unknown>): string | undefined {
  // axios normaliza los nombres de header a minúsculas.
  const raw = headers?.['x-config-version'];
  if (raw === undefined || raw === null || raw === '') return undefined;
  return String(raw);
}

/**
 * Prepara el array del replace masivo: le quita el flujo derivado a cada item,
 * por el mismo motivo que `create` (la API lo descarta igual, y mandarlo hace
 * creer que se guardó). Devuelve el body a mandar y los avisos.
 */
export function prepareBulkAutomations(body: unknown): { body: unknown; warnings: string[] } {
  if (!Array.isArray(body)) return { body, warnings: [] };
  const warnings: string[] = [];
  const items = body.map((a) =>
    a && typeof a === 'object' && !Array.isArray(a)
      ? stripDerivedFlow(a as AutomationInput, warnings)
      : a,
  );
  return { body: items, warnings };
}

/**
 * El replace masivo, que queda SÓLO como camino de último recurso
 * (`cce config set-remote automations`) y nunca sin `If-Match`.
 *
 * La versión llega por parámetro y NO se lee acá con un GET propio. Es la
 * diferencia entre proteger y aparentar que se protege: un GET hecho
 * milisegundos antes del PUT devuelve la versión de RECIÉN, así que el If-Match
 * siempre coincidiría y la API siempre aceptaría — incluido el caso que este
 * issue existe para cerrar (exportar, editar diez minutos, y reescribir encima
 * de lo que la App creó en el medio). El chequeo optimista sólo sirve si la
 * versión viene de la lectura en la que se BASÓ la edición: la imprime
 * `cce config show automations` y se pasa con `--if-match`.
 */
export async function replaceAllAutomations(
  client: AutomationsHttp,
  body: unknown,
  ifMatch: string,
): Promise<void> {
  const version = String(ifMatch ?? '').trim();
  if (!version) {
    throw new Error(
      'Falta --if-match: el replace masivo pisa el array ENTERO y sin la versión de la ' +
        'lectura que editaste no hay forma de saber si alguien escribió en el medio.\n' +
        '  cce config show automations   # imprime la versión (y el JSON a editar)\n' +
        '  … | cce config set-remote automations --if-match <version>',
    );
  }
  // La API compara con `Number(If-Match)`: cualquier cosa que no sea un número
  // da NaN y responde el MISMO 409 que una versión stale. Sin este chequeo, un
  // `--if-match *` sin comillas —que el shell expande al primer archivo del
  // directorio— se reportaría como «la config cambió desde la versión
  // autos.json», que manda a investigar un problema que no existe.
  if (!/^\d+$/.test(version) && version !== '*') {
    throw new Error(
      `--if-match inválido: "${version}". Tiene que ser el número de versión que imprime ` +
        '`cce config show automations`, o `*` para escribir sin chequeo.\n' +
        "Ojo: en bash/zsh el * sin comillas lo expande el shell — usá '*'.",
    );
  }
  try {
    await client.put('/config/automations', body, { headers: { 'If-Match': version } });
  } catch (e) {
    if (isApiError(e, 409)) {
      const current = currentVersionOf(e.data);
      throw new Error(
        `La config de automations cambió desde la versión ${version} que editabas` +
          `${current ? ` (ahora va por la ${current})` : ''}. No se escribió nada.\n` +
          'Volvé a leerla (`cce config show automations`), rehacé el cambio sobre lo ' +
          'nuevo y reintentá con la versión nueva.',
      );
    }
    throw e;
  }
}

/** La versión actual que la API manda en el body del 409, para poder decirla. */
function currentVersionOf(data: unknown): string | undefined {
  const body = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const v = body.currentVersion;
  return typeof v === 'number' || (typeof v === 'string' && v) ? String(v) : undefined;
}
