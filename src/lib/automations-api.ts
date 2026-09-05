import { Automation } from '../types/api.js';
import { ApiError, isApiError, isTransportError } from './api-client.js';

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
 * uno y lo devuelve. El resto se manda tal cual venga — validarlo acá sería
 * duplicar (y desincronizar) el DTO del backend, que ya responde 400 con la
 * ruta exacta del step que está mal.
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
   * true cuando el error fue de TRANSPORTE y no una respuesta del servidor: la
   * escritura pudo haberse aplicado igual. Ver `TransportError`.
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
 * que la API aceptó pero no persistió como el archivo pretendía.
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
 * trigger. Decir "reintentá tranquilo" en ese caso es un consejo que rompe
 * cosas.
 *
 * Un corte por transporte sobre un item SIN id cae en la misma trampa: no se
 * sabe si entró, así que reintentar puede duplicarlo igual.
 */
export function retryIsSafe(report: UpsertReport): boolean {
  if (report.applied.some((o) => o.idGeneratedByServer)) return false;
  if (report.failed?.stateUnknown && !report.failed.hadId) return false;
  return true;
}

/**
 * Crea o actualiza cada automatización del archivo, una por llamada.
 *
 * `create` es UPSERT: hoy el comando se usa para editar automatizaciones
 * existentes desde un archivo —exportar con `show --format json`, editar,
 * volver a aplicar— y convertirlo en error rompería ese flujo sin dar nada a
 * cambio.
 *
 * El orden es POST y, si no se pudo crear, PATCH. Que sea POST-first y no
 * PATCH-first es deliberado: el DTO del PATCH valida MÁS ANGOSTO que el del
 * POST (EugeValeiras/CCE#109 — `sourceAction: 'toggle'` es válido para crear y
 * da 400 al parchear), así que probar con PATCH primero haría fallar altas
 * perfectamente válidas. Mientras esa asimetría exista, una creación no puede
 * pasar por el PATCH.
 *
 * La contracara es que el POST valida el body COMPLETO (`name`, `enabled`,
 * `trigger` y `actions` son requeridos en `AutomationConfig`), así que un
 * parche parcial —`{id, enabled:false}`— se lleva un 400 del ValidationPipe
 * ANTES de que el handler pueda responder 409. Por eso el fallback al PATCH
 * cubre 409 (ya existe) y también 400 (no sirve para crear, pero puede ser un
 * parche válido sobre algo que ya existe): ver `upsertOne`.
 *
 * Diferencia real respecto del PUT masivo, y vale conocerla: el PATCH mergea
 * TOP-LEVEL, así que un campo que el archivo NO trae se conserva en vez de
 * borrarse. Es el lado seguro del cambio (omitir un campo ya no lo borra en
 * silencio), pero para vaciar una sección hay que mandarla explícitamente.
 */
export async function upsertAutomations(
  client: AutomationsHttp,
  items: AutomationInput[],
): Promise<UpsertReport> {
  const applied: UpsertOutcome[] = [];
  // Los avisos se calculan sobre lo que se INTENTÓ, no sobre el archivo
  // entero: tras un abort, avisar de items que nunca salieron es ruido que
  // manda a revisar el lugar equivocado.
  const attempted: AutomationInput[] = [];
  for (let i = 0; i < items.length; i++) {
    attempted.push(items[i]);
    try {
      applied.push(await upsertOne(client, items[i]));
    } catch (e) {
      return {
        applied,
        failed: {
          label: labelOf(items[i]),
          message: (e as Error).message,
          hadId: Boolean(items[i]?.id),
          stateUnknown: isTransportError(e),
        },
        notAttempted: items.slice(i + 1).map(labelOf),
        warnings: derivedFlowWarnings(attempted),
      };
    }
  }
  return { applied, notAttempted: [], warnings: derivedFlowWarnings(attempted) };
}

/**
 * El aviso del no-op silencioso más caro que tienen estos comandos.
 *
 * `show --format json` estampa `flowDerived: true` en toda automatización cuyo
 * `flow` es la PROYECCIÓN del formato viejo — que en esta casa son todas. Al
 * reenviarlo, `stripDerivedFlow()` de la API borra `flow` y `when` del body
 * antes de guardar (para no persistir un flujo derivado que quedaría stale
 * respecto de `actions`). O sea: exportar → editar el flujo → reaplicar
 * descarta la edición, y la API responde 200. Sin este aviso, el CLI imprimía
 * «✓ Actualizadas» sobre un cambio que no ocurrió.
 *
 * El CLI no borra `flowDerived` por su cuenta: no puede saber si el flujo del
 * archivo fue editado o es la proyección tal como salió, y quitarlo a ciegas
 * haría que la API persista un flujo derivado — el problema que la marca
 * existe para evitar. La decisión es del que editó, y acá se le dice cómo.
 *
 * Se exporta porque el replace masivo (`config set-remote automations`) manda
 * los mismos objetos por otra puerta y se come el mismo no-op.
 */
export function derivedFlowWarnings(items: AutomationInput[]): string[] {
  const marked = items.filter(
    (a) => a?.flowDerived === true && (a.flow !== undefined || a.when !== undefined),
  );
  if (!marked.length) return [];
  return [
    `${marked.length} automatización(es) vienen con "flowDerived": true ` +
      `(${marked.map(labelOf).join(', ')}): la API DESCARTA "flow" y "when" en esos items ` +
      'y guarda el resto, así que una edición del flujo NO se persiste. Si editaste el ' +
      'flujo, quitá "flowDerived" de ese item y volvé a aplicarlo.',
  ];
}

/** Los status del POST tras los cuales todavía puede haber un PATCH que sirva. */
const PATCH_WORTH_TRYING = new Set([400, 409]);

async function upsertOne(
  client: AutomationsHttp,
  item: AutomationInput,
): Promise<UpsertOutcome> {
  const id = typeof item?.id === 'string' ? item.id : '';
  const label = labelOf(item);
  let postError: ApiError;
  try {
    const { data } = await client.post<CreateAutomationResponse>('/config/automations', item);
    const assignedId = data?.automation?.id ?? id;
    if (!assignedId) {
      // Sin id no hay nada que reportar ni con qué volver a encontrarla: es
      // peor callarlo que cortar acá.
      throw new Error(
        'La API aceptó el POST pero no devolvió el id de la automatización creada ' +
          '(¿versión vieja de la API?). Revisá con `cce automations list`.',
      );
    }
    return { id: assignedId, label, action: 'created', idGeneratedByServer: !id };
  } catch (e) {
    // Un fallo de transporte NO se reintenta por otra vía: el POST pudo haber
    // llegado, y un PATCH detrás enturbiaría un estado ya dudoso.
    if (!id || !isApiError(e) || !PATCH_WORTH_TRYING.has(e.status)) throw e;
    postError = e;
  }

  // 409 = ya existe. 400 = el body no sirve para CREAR (le faltan requeridos),
  // lo que no impide que sea un parche válido sobre algo que ya existe.
  const { id: _ignored, ...body } = item;
  try {
    await client.patch(`/config/automations/${encodeURIComponent(id)}`, body);
  } catch (e) {
    // El PATCH dice que no existe y el POST había rechazado el body: entonces
    // el error de verdad es el del POST — el usuario quiso crear algo con un
    // body incompleto, y decirle «no existe» lo manda a buscar donde no es.
    if (isApiError(e, 404) && postError.status === 400) throw postError;
    // Si el POST devolvió 409, el ValidationPipe ya había aceptado el body
    // como `AutomationConfig`: un 400 del PATCH sobre ESE mismo body sólo
    // puede venir de que su DTO valida más angosto.
    if (postError.status === 409) throw explainPatchRejection(e);
    throw e;
  }
  return { id, label, action: 'updated', idGeneratedByServer: false };
}

/**
 * El 400 de un PATCH cuyo body la API ya aceptó como `AutomationConfig` (el
 * POST devolvió 409) no puede ser culpa del archivo.
 *
 * `PatchAutomationDto` valida más angosto que el DTO del POST/PUT: hoy
 * `sourceAction: 'toggle'` —una forma que la API soporta a propósito y que el
 * PUT masivo aceptaba— da 400 por esta vía. Es un bug de la API
 * (EugeValeiras/CCE#109) que el CLI no puede arreglar, pero sí puede evitar que
 * se lea como "tenés el archivo mal".
 */
function explainPatchRejection(e: unknown): unknown {
  if (!isApiError(e, 400)) return e;
  return new ApiError(
    `${e.message} — ojo: la API ya aceptó este body al intentar crearlo, así que el ` +
      'rechazo viene de que el DTO del PATCH valida más angosto que el del POST/PUT ' +
      "(p. ej. sourceAction 'toggle'). Ver EugeValeiras/CCE#109.",
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
