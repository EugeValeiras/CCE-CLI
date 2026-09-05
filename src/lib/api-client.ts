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
        const msg = typeof data === 'object' && data?.error ? data.error : JSON.stringify(data);
        return Promise.reject(new ApiError(`HTTP ${status}: ${msg}`, status, data));
      }
      if (err.code === 'ECONNREFUSED') {
        return Promise.reject(new Error(`Cannot reach CCE API at ${baseURL}. Is it running?`));
      }
      return Promise.reject(err);
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
