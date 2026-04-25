import { Command } from 'commander';
import ora from 'ora';
import { createApiClient, resolveHueHeaders, tuyaHeaders } from '../lib/api-client.js';
import { fail, info, printObject, success } from '../lib/format.js';
import { loadConfig, resolveFormat } from '../lib/user-config.js';

interface GlobalOpts {
  apiUrl?: string;
  format?: 'table' | 'json' | 'csv';
}

function getGlobals(cmd: Command): GlobalOpts {
  return cmd.optsWithGlobals<GlobalOpts>();
}

export function registerScanCommand(program: Command): void {
  const cmd = program
    .command('scan')
    .description('Escanear y sincronizar dispositivos nuevos por proveedor');

  cmd
    .command('hue')
    .description('Escanear luces y sensores Hue (requiere hue en config)')
    .action(async () => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Escaneando Hue...').start();
      try {
        const headers = await resolveHueHeaders(client);
        const [lights, sensors] = await Promise.all([
          client.post('/hue/lights/scan', {}, { headers }),
          client.post('/hue/sensors/scan', {}, { headers }),
        ]);
        spinner.stop();
        success('Scan Hue disparado.');
        printObject({ lights: lights.data, sensors: sensors.data }, fmt === 'table' ? 'json' : fmt);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('tuya')
    .description('Discover Tuya (LAN + Cloud) — usa credenciales de tuya en config')
    .option('--device <id...>', 'Limitar a deviceIds específicos', [])
    .action(async (opts: { device: string[] }) => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Escaneando Tuya...').start();
      try {
        const tuya = loadConfig().providers.tuya;
        if (!tuya) throw new Error('Tuya no configurado. Ver cce config set providers.tuya.*');
        const body = {
          accessId: tuya.accessId,
          accessSecret: tuya.accessSecret,
          region: tuya.region,
          deviceIds: opts.device ?? [],
        };
        const { data } = await client.post('/tuya/discover', body, { headers: tuyaHeaders() });
        spinner.stop();
        success('Discover Tuya ejecutado.');
        printObject(data, fmt === 'table' ? 'json' : fmt);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('ewelink')
    .description('Discover eWeLink (usa credenciales cargadas en el backend)')
    .action(async () => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Escaneando eWeLink...').start();
      try {
        const { data } = await client.post('/ewelink/discover');
        spinner.stop();
        success('Discover eWeLink ejecutado.');
        printObject(data, fmt === 'table' ? 'json' : fmt);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('z2m')
    .description('Zigbee2MQTT: (informativo) — los dispositivos se descubren vía MQTT permit-join')
    .action(() => {
      info('Zigbee2MQTT no expone un endpoint HTTP de scan en CCE-API.');
      info('Habilitá permit_join desde el frontend o directamente vía MQTT:');
      info('  mosquitto_pub -t zigbee2mqtt/bridge/request/permit_join -m \'{"value": true, "time": 120}\'');
    });
}
