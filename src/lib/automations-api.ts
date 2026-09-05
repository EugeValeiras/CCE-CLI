import { Automation } from '../types/api.js';
import { isApiError } from './api-client.js';

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
 * como estén. Por eso acá no hay ningún read-modify-write; el estado previo
 * que hace falta consultar lo consulta el server.
 *
 * La lógica vive separada de `commands/automations.ts` para que sea testeable
 * con un cliente HTTP falso: lo que hay que poder afirmar de estas operaciones
 * es el método y la ruta que mandan, no lo que imprimen.
 */

/** Una respuesta HTTP, en lo mínimo que estas operaciones miran. */
export interface HttpResponse<T = unknown> {
  data: T;
  headers?: Record<string, unknown>;
}

/**
 * Lo mínimo que estas operaciones necesitan de un cliente HTTP. Un
 * `AxiosInstance` lo cumple; un objeto de test que registra método y ruta,
 * también.
 */
export interface AutomationsHttp {
  get<T = unknown>(url: string, config?: unknown): Promise<HttpResponse<T>>;
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
  action: 'created' | 'updated';
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
 * silencio: `applied` dice qué quedó escrito, `failed` en cuál cortó y por
 * qué, y `notAttempted` qué ni se intentó. Reintentar el archivo entero
 * después de corregirlo es seguro: el upsert es idempotente.
 */
export interface UpsertReport {
  applied: UpsertOutcome[];
  failed?: { label: string; message: string };
  notAttempted: string[];
}

/** Cómo nombrar una automatización del archivo en un mensaje de error. */
export function labelOf(item: AutomationInput): string {
  if (typeof item?.id === 'string' && item.id) return item.id;
  if (typeof item?.name === 'string' && item.name) return `«${item.name}»`;
  return '(sin id ni nombre)';
}

/**
 * Crea o actualiza cada automatización del archivo, una por llamada.
 *
 * `create` sigue siendo UPSERT (POST y, si la API responde 409 porque el id ya
 * existe, PATCH). No es inercia: hoy el comando se usa para editar
 * automatizaciones existentes desde un archivo —exportar con `show --format
 * json`, editar, volver a aplicar— y convertirlo en error rompería ese flujo
 * sin dar nada a cambio.
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
  for (let i = 0; i < items.length; i++) {
    try {
      applied.push(await upsertOne(client, items[i]));
    } catch (e) {
      return {
        applied,
        failed: { label: labelOf(items[i]), message: (e as Error).message },
        notAttempted: items.slice(i + 1).map(labelOf),
      };
    }
  }
  return { applied, notAttempted: [] };
}

async function upsertOne(
  client: AutomationsHttp,
  item: AutomationInput,
): Promise<UpsertOutcome> {
  try {
    const { data } = await client.post<CreateAutomationResponse>('/config/automations', item);
    return { id: data?.automation?.id ?? String(item.id ?? ''), action: 'created' };
  } catch (e) {
    const id = typeof item?.id === 'string' ? item.id : '';
    // 409 es la respuesta esperable de un upsert sobre algo que ya existe; el
    // resto de los errores (400 de validación, 401, red) son del caller.
    if (!id || !isApiError(e, 409)) throw e;
    const { id: _ignored, ...body } = item;
    await client.patch(`/config/automations/${encodeURIComponent(id)}`, body);
    return { id, action: 'updated' };
  }
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
  const raw = headers?.['x-config-version'] ?? headers?.['X-Config-Version'];
  if (raw === undefined || raw === null || raw === '') return undefined;
  return String(raw);
}

/**
 * El replace masivo, que queda SÓLO como camino de último recurso
 * (`cce config set-remote automations`) y nunca sin `If-Match`.
 *
 * Sin la versión no se manda nada: un PUT sin If-Match es exactamente el
 * clobber silencioso que este issue viene a cerrar, y fallar es preferible a
 * escribir a ciegas.
 */
export async function replaceAllAutomations(
  client: AutomationsHttp,
  body: unknown,
): Promise<void> {
  const { headers } = await client.get('/config/automations');
  const version = readConfigVersion(headers);
  if (!version) {
    throw new Error(
      'La API no devolvió X-Config-Version en GET /config/automations: sin esa versión el ' +
        'replace masivo se enviaría sin If-Match y podría pisar cambios de la App o el ' +
        'Dashboard. Actualizá la API, o usá `cce automations create -f` (item-level).',
    );
  }
  try {
    await client.put('/config/automations', body, { headers: { 'If-Match': version } });
  } catch (e) {
    if (isApiError(e, 409)) {
      throw new Error(
        `La config de automations cambió mientras editabas (tu versión: ${version}). ` +
          'No se escribió nada. Volvé a leerla (`cce config show automations`), ' +
          'rehacé el cambio sobre lo nuevo y reintentá.',
      );
    }
    throw e;
  }
}
