export enum DeviceCapability {
  Switch = 'switch',
  Brightness = 'brightness',
  ColorTemperature = 'color_temperature',
  ColorHSV = 'color_hsv',
  Sensor = 'sensor',
  Button = 'button',
  Motion = 'motion',
  Contact = 'contact',
}

export interface DeviceIdentifier {
  provider: string;
  nativeId: string;
  globalId: string;
}

export interface DeviceState {
  on: boolean;
  bri: number;
  hue?: number;
  sat?: number;
  ct?: number;
  reachable: boolean;
  mode?: string;
}

export interface SensorState {
  temperature?: number;
  humidity?: number;
  battery?: string;
  motion?: boolean;
  contact?: boolean;
  brightness?: string;
  lastKey?: number;
  outlet?: number;
  outlets?: number;
  trigTime?: number;
}

export interface DeviceBinding {
  bindingId: string;
  provider: string;
  identifier?: string;
  capabilities: DeviceCapability[];
  available: boolean;
  /**
   * Cuándo la API armó su lista de devices, NO cuándo se supo algo de este
   * binding. Se llamaba `lastSeen` y no era eso: el merge lo sella con la hora
   * del rebuild —hay uno por minuto— para todos los bindings presentes, uno
   * caído incluido, así que decía «hace un minuto» de uno que llevaba días
   * mudo (CCE#154). Medido contra la casa: los 137 bindings de los 76 devices
   * traían el MISMO milisegundo, los dos caídos entre ellos.
   *
   * Para «¿hace cuánto está caído?» este número no sirve; la señal que haría
   * falta todavía no existe en el backend.
   */
  lastRebuiltAt: number;
  priority: number;
}

export interface MergedDevice {
  id: string;
  identifier?: string;
  name: string;
  type: string;
  manufacturer: string;
  productname?: string;
  modelid: string;
  capabilities: DeviceCapability[];
  state: DeviceState;
  sensor?: SensorState;
  bindings: DeviceBinding[];
  preferredBindingId: string;
}

export interface AutomationTrigger {
  type:
    | 'manual'
    | 'schedule'
    | 'sensor'
    | 'calendar'
    | 'incomingCall'
    | 'callStarted'
    | 'callEnded';
  [key: string]: unknown;
}

export interface Automation {
  id: string;
  name: string;
  icon: string;
  enabled: boolean;
  source: 'scene' | 'group' | 'custom' | 'hueScene' | 'hueRoom';
  sourceId?: string;
  sourceAction?: 'on' | 'off' | 'toggle';
  mode: 'toggle' | 'full';
  trigger: AutomationTrigger;
  actions: AutomationAction[];
  planId?: string;

  // ── Modelo de FLUJO (CCE#64) ──────────────────────────────────────────────
  // El backend devuelve `when` + `flow` en cada automatización de
  // GET /config/automations. `trigger` y `actions` NO se van: siguen ahí para
  // el Dashboard y la App, y el CLI los sigue mostrando donde tienen sentido.
  //
  // Estos campos tienen que estar DECLARADOS para no perderse al reenviarlos.
  // En runtime TypeScript no borra nada —el objeto viene del GET y se reenvía
  // tal cual—, pero el DTO del backend sí: con `whitelist: true` el
  // ValidationPipe descarta todo campo que no declare. Que el tipo de acá lo
  // refleje es lo que hace que el contrato se lea igual de los dos lados.
  //
  // CCE#107 — el CLI ya no hace read-modify-write del array entero, pero el
  // punto sigue en pie: `create` reenvía la automatización COMPLETA por POST o
  // PATCH (y el PATCH mergea top-level, así que lo que no se manda no se
  // toca), y `cce config set-remote automations` manda el array entero.

  /** Los triggers, ya como lista. */
  when?: AutomationTrigger[];

  /** El árbol de steps. */
  flow?: FlowStep[];

  /**
   * true cuando el `flow` de esta respuesta es la PROYECCIÓN del formato viejo
   * y no algo que alguien escribió. Se reenvía tal cual: el backend lo usa para
   * NO persistir un flujo derivado (y así no dejarlo stale respecto de
   * `actions`). No inventarlo ni borrarlo desde acá.
   */
  flowDerived?: boolean;

  /** Qué hacer si llega una corrida con una instancia viva. Default 'restart'. */
  onRetrigger?: 'restart' | 'ignore' | 'queue' | 'parallel';
}

// ── Los steps y las condiciones del flujo (CCE#64) ──────────────────────────

export type FlowCond =
  | { and: FlowCond[] }
  | { or: FlowCond[] }
  | { not: FlowCond }
  | Record<string, unknown>;

export type FlowStep =
  | { type: 'do'; actions: FlowAction[] }
  | { type: 'if'; cond: FlowCond; then: FlowStep[]; else?: FlowStep[] }
  | { type: 'wait'; seconds: number }
  | { type: 'waitFor'; cond: FlowCond; timeoutSeconds: number; onTimeout?: FlowStep[] }
  | { type: 'stop' };

/**
 * Una acción del modelo nuevo: `kind` explícito y el target en un campo con
 * nombre real (hueRoomId/sceneId/deviceId/announcerId/…), en vez de `on` como
 * discriminador y `lightId` con sentinelas `__hueroom__…` / `__automations__`.
 */
export interface FlowAction {
  kind:
    | 'device'
    | 'deviceVerb'
    | 'group'
    | 'scene'
    | 'hueScene'
    | 'hueRoom'
    | 'notification'
    | 'announce'
    | 'automation'
    | 'jbl'
    | 'alarm'
    | 'call';
  [key: string]: unknown;
}

export interface AutomationAction {
  lightId: string;
  on:
    | boolean
    | 'toggle'
    | 'bri_up'
    | 'bri_down'
    | 'notification'
    | 'alarm'
    | 'jbl'
    | 'group'
    | 'hueRoom'
    | 'device'
    | 'scene'
    | 'hueScene'
    | 'call'
    | 'announce'
    | 'automation';
  bri?: number;
  briDelta?: number;
  hue?: number;
  sat?: number;
  ct?: number;
  notificationMessage?: string;
  notificationSound?: 'alarm' | 'doorbell' | 'alert';
  notificationType?: 'critical' | 'alert' | 'info';
  alarmAction?: 'arm' | 'disarm' | 'toggle';
  /** Para on === 'jbl' (sentinel '__jbl__'): prender/apagar la soundbar. Default 'on'. */
  jblAction?: 'on' | 'off';
  /**
   * Solo con jblAction 'on'. AUSENTE = 'resume' (compat con acciones ya guardadas):
   * 'resume' reanuda la última cola sintonizada; 'plain' prende sin reanudar
   * (solo tecla de power); 'radio' reproduce la radio guardada jblRadioName.
   */
  jblOnMode?: 'resume' | 'plain' | 'radio';
  /** Requerido cuando jblOnMode === 'radio': nombre de una radio guardada (GET /api/jbl/radios). */
  jblRadioName?: string;
}

/**
 * F14 — entry heterogénea ("modo cine"): un device (deviceId) con O `state`
 * (on/bri/...) O `action` de catálogo ({verb,args}). Se ejecuta server-side vía
 * POST /config/scenes/:id/run junto con lights[]. Read-both: escenas viejas
 * solo-lights siguen igual.
 */
export interface SceneEntry {
  deviceId: string;
  state?: { on?: boolean; bri?: number; hue?: number; sat?: number; ct?: number };
  action?: { verb: string; args?: Record<string, unknown> };
}

export interface Scene {
  id: string;
  name: string;
  icon?: string;
  lights?: { lightId: string; on: boolean; bri: number; hue?: number; sat?: number; ct?: number }[];
  entries?: SceneEntry[];
  planId?: string;
}

export interface LightGroup {
  id: string;
  name: string;
  lightIds: string[];
  icon?: string;
  planId?: string;
}

export interface LightBroadcast {
  lightId: string;
  state: Partial<DeviceState>;
  sensor?: SensorState;
  source: 'api' | 'external';
  timestamp: number;
}

export interface DeviceStateChangedBroadcast {
  deviceId: string;
  state: Partial<DeviceState>;
  sensor?: SensorState;
  source: string;
  timestamp: number;
}

export interface AutomationExecutedBroadcast {
  automationId: string;
  trigger: string;
  sensorId?: string;
  timestamp: number;
}

export type EventChannel = 'internal' | 'websocket';

export interface EventRecord {
  time: string;
  id: string;
  channel: EventChannel;
  eventName: string;
  source: string | null;
  globalId: string | null;
  provider: string | null;
  payload: Record<string, unknown> | unknown[] | null;
}

export interface EventsListResponse {
  items: EventRecord[];
  nextCursor: string | null;
  enabled: boolean;
}

// ── Métricas de la Pi (EugeValeiras/CCE#174) ─────────────────────────────────
// Copiado de `CCE-API/src/system/system-metrics.types.ts`: la forma de
// `GET /api/system/metrics` y del evento `metrics:sample`. Todo lo que sale de
// `/proc` o `/sys` es NULLABLE (una API fuera de Linux responde
// `available: false` con esos bloques en `null`).

export type ThrottleFlag = 'under-voltage' | 'freq-capped' | 'throttled' | 'soft-temp-limit';

export interface ThrottledState {
  raw: number;
  /** Lo que pasa AHORA. Vacío = todo bien. */
  active: ThrottleFlag[];
  /** Lo que pasó alguna vez desde el arranque del host. */
  occurred: ThrottleFlag[];
}

export interface CpuMetrics {
  /** 0-100, delta de `/proc/stat` contra la muestra anterior. */
  usagePct: number | null;
  perCore: number[] | null;
  load1: number;
  load5: number;
  load15: number;
  tempC: number | null;
  throttled: ThrottledState | null;
}

export interface MemMetrics {
  totalBytes: number;
  /** `MemTotal - MemAvailable`. */
  usedBytes: number;
  /** `MemAvailable`: lo que mira el OOM killer. */
  availableBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

export interface DiskUsage {
  mount: string;
  device: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  /** El `Use%` de `df`. */
  usedPct: number;
}

export interface DiskIo {
  /** El disco entero: `mmcblk0`, `nvme0n1`. */
  device: string;
  readBytesPerSec: number;
  writeBytesPerSec: number;
  readOpsPerSec: number;
  writeOpsPerSec: number;
}

export interface NetIo {
  iface: string;
  rxBytesPerSec: number;
  txBytesPerSec: number;
}

export interface ProcessMetrics {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  /** p99 del retraso del event loop en el intervalo, en ms. */
  eventLoopLagMs: number;
}

export interface MetricsSample {
  /** Epoch ms. La clave de `?after=`. */
  sampledAt: number;
  cpu: CpuMetrics;
  mem: MemMetrics | null;
  disk: DiskUsage[] | null;
  io: DiskIo[] | null;
  net: NetIo[] | null;
  process: ProcessMetrics;
  uptime: { hostSec: number; processSec: number };
}

export interface HostInfo {
  hostname: string;
  cores: number;
  arch: string;
  kernel: string;
  platform: string;
}

export interface SystemMetricsResponse {
  available: boolean;
  intervalMs: number;
  retainedMinutes: number;
  host: HostInfo;
  /** `null` sólo antes de la primera muestra (los primeros 5 s de la API). */
  current: MetricsSample | null;
  history: MetricsSample[];
}
