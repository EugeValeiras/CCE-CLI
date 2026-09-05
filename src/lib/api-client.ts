import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { loadConfig, resolveApiToken, resolveApiUrl } from './user-config.js';

export interface ClientOptions {
  apiUrl?: string;
  timeoutMs?: number;
}

/**
 * CCE#107 — El error de la API, con el status a la vista.
 *
 * El interceptor siempre aplanó la respuesta a `Error('HTTP 409: ...')`: el
 * mensaje quedaba legible pero el status sólo sobrevivía como texto, y ningún
 * caller podía ramificar sin parsearlo con una regex. Los endpoints item-level
 * de automations distinguen justo por status —409 «ya existe» es el pivote del
 * upsert, 404 es «no existe»—, así que el status viaja como dato.
 *
 * `message` no cambia: lo que ya se imprimía se sigue imprimiendo igual.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** true si `e` es un ApiError; con `status`, además, si es ESE status. */
export function isApiError(e: unknown, status?: number): e is ApiError {
  return e instanceof ApiError && (status === undefined || e.status === status);
}

/**
 * CCE#107 — La petición no llegó a tener respuesta: timeout, conexión cortada,
 * DNS, la API caída.
 *
 * La diferencia con `ApiError` no es cosmética: un status es la respuesta del
 * servidor, o sea un estado CONOCIDO (409 = existe, 400 = no se guardó). Un
 * error de transporte deja el estado DESCONOCIDO — un POST que muere por
 * ECONNRESET pudo haberse aplicado igual, y la respuesta perderse de vuelta.
 * Tratar eso como «no se escribió» es lo que convierte un reintento en un
 * duplicado.
 */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export function isTransportError(e: unknown): e is TransportError {
  return e instanceof TransportError;
}

/**
 * El mensaje ÚTIL de un error de la API.
 *
 * Nest arma el body como `{ statusCode, message, error }`, donde `message` es
 * lo que el handler escribió y `error` es la frase genérica del status. El
 * interceptor leía `error`, así que TODO error del CLI se imprimía como
 * «HTTP 404: Not Found» o «HTTP 400: Bad Request» — con el mensaje real
 * («No existe la automatización auto_1», o qué campo rechazó el
 * ValidationPipe) descartado en el camino.
 *
 * Los cuatro cuerpos que manda esta API:
 *  - `{ message: 'No existe la automatización auto_1', error: 'Not Found' }`
 *  - `{ message: ['sourceAction must be one of…'], error: 'Bad Request' }` (ValidationPipe)
 *  - `{ message: 'Flujo inválido en …', errors: ['flow[0].then[1].cond: …'] }` (acceptFlow)
 *  - `{ message: 'Config de automations stale: …', currentVersion: 621 }` (409 del PUT)
 */
export function apiErrorMessage(status: number, data: unknown): string {
  const body = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
  const parts: string[] = [];

  const message = body.message;
  if (typeof message === 'string' && message.trim()) parts.push(message.trim());
  else if (Array.isArray(message) && message.length) parts.push(message.map(String).join('; '));
  else if (typeof body.error === 'string' && body.error.trim()) parts.push(body.error.trim());
  else if (typeof data === 'string' && data.trim()) parts.push(data.trim());
  else if (data !== undefined && data !== null) parts.push(JSON.stringify(data));
  else parts.push(`sin cuerpo (HTTP ${status})`);

  // `errors` es la lista de rutas del validador de flujos: sin ella un
  // «Flujo inválido» no dice QUÉ step está mal, que es lo único accionable.
  const errors = body.errors;
  if (Array.isArray(errors) && errors.length) parts.push(`(${errors.map(String).join('; ')})`);

  return parts.join(' ');
}

export function createApiClient(opts: ClientOptions = {}): AxiosInstance {
  const baseURL = `${resolveApiUrl(opts.apiUrl).replace(/\/$/, '')}/api`;
  const apiToken = resolveApiToken();
  const client = axios.create({
    baseURL,
    timeout: opts.timeoutMs ?? 15000,
    headers: {
      'Content-Type': 'application/json',
      ...(apiToken ? { 'X-CCE-Token': apiToken } : {}),
    },
  });
  client.interceptors.response.use(
    (r) => r,
    (err) => {
      if (err.response) {
        const { status, data } = err.response;
        return Promise.reject(
          new ApiError(`HTTP ${status}: ${apiErrorMessage(status, data)}`, status, data),
        );
      }
      if (err.code === 'ECONNREFUSED') {
        return Promise.reject(
          new TransportError(
            `Cannot reach CCE API at ${baseURL}. Is it running?`,
            err.code,
            err,
          ),
        );
      }
      // Timeout, conexión cortada, DNS: la petición SALIÓ y no sabemos si el
      // servidor la aplicó. Ver `TransportError`.
      return Promise.reject(
        new TransportError(
          `${err.message ?? 'fallo de red'} (${err.code ?? 'sin código'}) contra ${baseURL}`,
          err.code,
          err,
        ),
      );
    },
  );
  return client;
}

export function hueHeaders(): Record<string, string> {
  const hue = loadConfig().providers.hue;
  if (!hue?.bridgeIp || !hue?.apiKey) {
    throw new Error(
      'Hue no configurado. Corré: cce config set providers.hue.bridgeIp <ip> && cce config set providers.hue.apiKey <key>',
    );
  }
  return { 'X-Bridge-Ip': hue.bridgeIp, 'X-Api-Key': hue.apiKey };
}

/**
 * Resuelve credenciales de Hue mirando primero el config local y, si no están,
 * cayendo al config remoto del backend (/api/config/hue). Esto permite usar el
 * CLI sin duplicar bridgeIp/apiKey en ~/.cce/config.json cuando ya están
 * cargadas en el backend.
 */
export async function resolveHueHeaders(
  client: AxiosInstance,
): Promise<Record<string, string>> {
  const local = loadConfig().providers.hue;
  if (local?.bridgeIp && local?.apiKey) {
    return { 'X-Bridge-Ip': local.bridgeIp, 'X-Api-Key': local.apiKey };
  }
  try {
    const { data } = await client.get<{ bridgeIp?: string; apiKey?: string }>('/config/hue');
    if (data?.bridgeIp && data?.apiKey) {
      return { 'X-Bridge-Ip': data.bridgeIp, 'X-Api-Key': data.apiKey };
    }
  } catch {
    // fallthrough al error uniforme
  }
  throw new Error(
    'Hue no configurado. Cargá credenciales con:\n' +
      '  cce config set providers.hue.bridgeIp <ip>\n' +
      '  cce config set providers.hue.apiKey <key>\n' +
      'o dejalas en el backend (ver cce config show hue).',
  );
}

export function tuyaHeaders(): Record<string, string> {
  const tuya = loadConfig().providers.tuya;
  if (!tuya?.accessId || !tuya?.accessSecret || !tuya?.region) {
    throw new Error(
      'Tuya no configurado. Corré: cce config set providers.tuya.accessId <id> (ademas accessSecret y region)',
    );
  }
  return {
    'X-Tuya-Access-Id': tuya.accessId,
    'X-Tuya-Access-Secret': tuya.accessSecret,
    'X-Tuya-Region': tuya.region,
  };
}

export function withProviderHeaders(
  config: AxiosRequestConfig,
  headers: Record<string, string>,
): AxiosRequestConfig {
  return { ...config, headers: { ...(config.headers ?? {}), ...headers } };
}
