import http from 'node:http';
import { ApiError, TransportError, apiErrorMessage } from '../../src/lib/api-client.js';
import { AutomationsHttp, HttpResponse } from '../../src/lib/automations-api.js';

/**
 * CCE#107 — Un doble de CCE-API fiel en lo que decide el comportamiento del CLI.
 *
 * La primera versión de estos tests usaba un fake complaciente: respondía 409
 * ante cualquier POST con id repetido SIN validar el body. Con eso, el caso
 * «mandá un parche parcial `{id, enabled:false}` y que el upsert lo resuelva
 * por PATCH» pasaba en verde… y contra la API real fallaba con 400, porque el
 * ValidationPipe global corre ANTES del handler y `name`/`enabled`/`trigger`/
 * `actions` son requeridos en `AutomationConfig`. El test verificaba el fake,
 * no el contrato.
 *
 * Reglas copiadas de (CCE-API):
 *  - `src/automation/dto/automation.dto.ts` — `AutomationConfig` (POST/PUT):
 *    id/name `@IsString @IsNotEmpty`, enabled `@IsBoolean`, trigger
 *    `@IsObject`, actions `@IsArray`; sourceAction `@IsIn(['on','off','toggle'])`.
 *    `PatchAutomationDto`: todo `@IsOptional`, y sourceAction sólo
 *    `@IsIn(['on','off'])` — la asimetría de EugeValeiras/CCE#109.
 *  - `src/main.ts` — ValidationPipe global con `whitelist: true`.
 *  - `src/config/config.controller.ts` — 409/404 item-level, If-Match del PUT
 *    masivo (`Number(raw) !== current` ⇒ 409, así que un valor no numérico da
 *    el MISMO 409 que una versión vieja).
 *  - `src/automation/flow/flow-derive.ts` — `stripDerivedFlow`: con
 *    `flowDerived: true` borra `flow`, `when` y la marca.
 */

export interface Stored extends Record<string, unknown> {
  id: string;
}

export interface Call {
  method: string;
  path: string;
  body?: unknown;
  ifMatch?: string;
}

interface Reply {
  status: number;
  body: unknown;
}

const nest = (status: number, message: string | string[], error: string): Reply => ({
  status,
  body: { message, error, statusCode: status },
});

export class FakeCceApi {
  automations: Stored[];
  version: number;
  readonly calls: Call[] = [];
  /** Corre después de CADA request, para colar una escritura ajena en el medio. */
  afterCall?: (nth: number, api: FakeCceApi) => void;
  /** Si está seteado, la próxima request con este método/ruta muere sin respuesta. */
  killNext?: { method: string; contains?: string };

  constructor(initial: Stored[] = [], version = 620) {
    this.automations = [...initial];
    this.version = version;
  }

  /** Los requeridos de `AutomationConfig` (POST y PUT). */
  private validateFull(body: Record<string, unknown>): string[] {
    const errors: string[] = [];
    if (body.id !== undefined) {
      if (typeof body.id !== 'string') errors.push('id must be a string');
      else if (!body.id) errors.push('id should not be empty');
    }
    if (typeof body.name !== 'string') errors.push('name must be a string');
    else if (!body.name) errors.push('name should not be empty');
    if (typeof body.enabled !== 'boolean') errors.push('enabled must be a boolean value');
    if (typeof body.trigger !== 'object' || body.trigger === null) {
      errors.push('trigger must be an object');
    }
    if (!Array.isArray(body.actions)) errors.push('actions must be an array');
    if (
      body.sourceAction !== undefined &&
      !['on', 'off', 'toggle'].includes(String(body.sourceAction))
    ) {
      errors.push('sourceAction must be one of the following values: on, off, toggle');
    }
    return errors;
  }

  /** `PatchAutomationDto`: todo opcional, y sourceAction SIN 'toggle' (CCE#109). */
  private validatePatch(body: Record<string, unknown>): string[] {
    const errors: string[] = [];
    if (body.name !== undefined) {
      if (typeof body.name !== 'string') errors.push('name must be a string');
      else if (!body.name) errors.push('name should not be empty');
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      errors.push('enabled must be a boolean value');
    }
    if (body.sourceAction !== undefined && !['on', 'off'].includes(String(body.sourceAction))) {
      errors.push('sourceAction must be one of the following values: on, off');
    }
    return errors;
  }

  /** `stripDerivedFlow`: un flujo marcado como derivado no se persiste. */
  private strip(body: Record<string, unknown>): Record<string, unknown> {
    if (body.flowDerived !== true) return body;
    const out = { ...body };
    delete out.flow;
    delete out.when;
    delete out.flowDerived;
    return out;
  }

  handle(method: string, path: string, body?: unknown, ifMatch?: string): Reply {
    this.calls.push({ method, path, body, ifMatch });
    try {
      return this.route(method, path, body, ifMatch);
    } finally {
      this.afterCall?.(this.calls.length, this);
    }
  }

  private route(method: string, path: string, body?: unknown, ifMatch?: string): Reply {
    const id = decodeURIComponent(path.replace('/api/config/automations/', ''));
    const payload = (body ?? {}) as Record<string, unknown>;

    if (path === '/api/config/automations' && method === 'GET') {
      return { status: 200, body: this.automations };
    }

    if (path === '/api/config/automations' && method === 'POST') {
      // El ValidationPipe corre ANTES del handler: un body inválido nunca
      // llega a enterarse de si el id existe.
      const errors = this.validateFull(payload);
      if (errors.length) return nest(400, errors, 'Bad Request');
      const wanted = String(payload.id ?? `auto_gen_${this.automations.length}`);
      if (this.automations.some((a) => a.id === wanted)) {
        return nest(409, `Ya existe una automatización con id ${wanted}`, 'Conflict');
      }
      const created = { ...this.strip(payload), id: wanted } as Stored;
      this.automations.push(created);
      this.version++;
      return { status: 201, body: { success: true, automation: created, version: this.version } };
    }

    if (path.startsWith('/api/config/automations/') && method === 'PATCH') {
      const errors = this.validatePatch(payload);
      if (errors.length) return nest(400, errors, 'Bad Request');
      const i = this.automations.findIndex((a) => a.id === id);
      if (i === -1) return nest(404, `No existe la automatización ${id}`, 'Not Found');
      const { id: _whitelisted, ...rest } = payload;
      this.automations[i] = { ...this.automations[i], ...this.strip(rest) } as Stored;
      this.version++;
      return {
        status: 200,
        body: { success: true, automation: this.automations[i], version: this.version },
      };
    }

    if (path.startsWith('/api/config/automations/') && method === 'DELETE') {
      const i = this.automations.findIndex((a) => a.id === id);
      if (i === -1) return nest(404, `No existe la automatización ${id}`, 'Not Found');
      this.automations.splice(i, 1);
      this.version++;
      return { status: 200, body: { success: true, version: this.version } };
    }

    if (path === '/api/config/automations' && method === 'PUT') {
      const raw = (ifMatch ?? '').trim();
      // Como la API: `Number(raw)` — cualquier cosa no numérica da NaN y cae en
      // el mismo 409 que una versión stale.
      if (raw && raw !== '*' && Number(raw.replace(/^W\//i, '').replace(/"/g, '')) !== this.version) {
        return {
          status: 409,
          body: {
            message: `Config de automations stale: If-Match ${raw} != versión actual ${this.version}. Refrescá y reintentá.`,
            currentVersion: this.version,
          },
        };
      }
      const list = Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
      for (const a of list) {
        const errors = this.validateFull(a);
        if (errors.length) return nest(400, errors, 'Bad Request');
      }
      this.automations = list.map((a) => this.strip(a) as Stored);
      this.version++;
      return { status: 200, body: { success: true, version: this.version } };
    }

    return nest(404, `Cannot ${method} ${path}`, 'Not Found');
  }

  private shouldKill(method: string, path: string): boolean {
    if (!this.killNext || this.killNext.method !== method) return false;
    if (this.killNext.contains && !path.includes(this.killNext.contains)) return false;
    this.killNext = undefined;
    return true;
  }

  /**
   * El doble como cliente HTTP en memoria, lanzando los MISMOS errores que
   * produce el interceptor real (`apiErrorMessage` mediante).
   */
  asHttpClient(): AutomationsHttp {
    const call = async <T>(
      method: string,
      url: string,
      body?: unknown,
      config?: unknown,
    ): Promise<HttpResponse<T>> => {
      const path = `/api${url}`;
      if (this.shouldKill(method, path)) {
        // La petición SALIÓ (el server la aplica) y la respuesta se pierde:
        // el caso que deja el estado en duda.
        this.handle(method, path, body, headerOf(config));
        throw new TransportError('socket hang up (ECONNRESET) contra el doble', 'ECONNRESET');
      }
      const reply = this.handle(method, path, body, headerOf(config));
      if (reply.status >= 400) {
        throw new ApiError(
          `HTTP ${reply.status}: ${apiErrorMessage(reply.status, reply.body)}`,
          reply.status,
          reply.body,
        );
      }
      return { data: reply.body as T };
    };
    return {
      post: <T>(url: string, body?: unknown, config?: unknown) =>
        call<T>('POST', url, body, config),
      patch: <T>(url: string, body?: unknown, config?: unknown) =>
        call<T>('PATCH', url, body, config),
      put: <T>(url: string, body?: unknown, config?: unknown) => call<T>('PUT', url, body, config),
      delete: <T>(url: string, config?: unknown) => call<T>('DELETE', url, undefined, config),
    };
  }

  /** El doble como servidor HTTP, para ejercitar axios y el interceptor reales. */
  listen(): Promise<{ url: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const path = new URL(req.url ?? '', 'http://x').pathname;
        const method = req.method ?? 'GET';
        if (this.shouldKill(method, path)) {
          this.handle(method, path, raw ? JSON.parse(raw) : undefined, ifMatchHeader(req));
          req.socket.destroy(); // el cliente ve ECONNRESET; el server ya aplicó
          return;
        }
        const reply = this.handle(
          method,
          path,
          raw ? JSON.parse(raw) : undefined,
          ifMatchHeader(req),
        );
        res.writeHead(reply.status, {
          'Content-Type': 'application/json',
          'X-Config-Version': String(this.version),
        });
        res.end(JSON.stringify(reply.body));
      });
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('no arrancó el doble');
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise<void>((done) => server.close(() => done())),
        });
      });
    });
  }
}

function headerOf(config?: unknown): string | undefined {
  return (config as { headers?: Record<string, string> } | undefined)?.headers?.['If-Match'];
}

function ifMatchHeader(req: http.IncomingMessage): string | undefined {
  const v = req.headers['if-match'];
  return Array.isArray(v) ? v[0] : v;
}

/** Una automatización COMPLETA, como la exige `AutomationConfig`. */
export function fullAutomation(id?: string, extra: Record<string, unknown> = {}) {
  return {
    ...(id ? { id } : {}),
    name: id ? `auto ${id}` : 'sin id',
    enabled: true,
    trigger: { type: 'manual' },
    actions: [],
    ...extra,
  };
}
