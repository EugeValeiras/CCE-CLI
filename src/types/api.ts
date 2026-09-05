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
  lastSeen: number;
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
