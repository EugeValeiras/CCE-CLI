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

export interface Automation {
  id: string;
  name: string;
  icon: string;
  enabled: boolean;
  source: 'scene' | 'group' | 'custom';
  sourceId?: string;
  sourceAction?: 'on' | 'off';
  mode: 'toggle' | 'full';
  trigger: {
    type: 'manual' | 'schedule' | 'sensor';
    [key: string]: unknown;
  };
  actions: AutomationAction[];
  planId?: string;
}

export interface AutomationAction {
  lightId: string;
  on: boolean | 'toggle' | 'bri_up' | 'bri_down' | 'notification' | 'alarm';
  bri?: number;
  briDelta?: number;
  hue?: number;
  sat?: number;
  ct?: number;
  notificationMessage?: string;
  notificationSound?: 'alarm' | 'doorbell' | 'alert';
  notificationType?: 'critical' | 'alert' | 'info';
  alarmAction?: 'arm' | 'disarm' | 'toggle';
}

export interface Scene {
  id: string;
  name: string;
  icon?: string;
  lights: { lightId: string; on: boolean; bri: number; hue?: number; sat?: number; ct?: number }[];
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
