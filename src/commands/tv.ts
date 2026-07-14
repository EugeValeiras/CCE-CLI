import { Command } from 'commander';
import ora from 'ora';
import { createApiClient } from '../lib/api-client.js';
import { fail, printObject, success, OutputFormat } from '../lib/format.js';
import { resolveFormat } from '../lib/user-config.js';

interface GlobalOpts {
  apiUrl?: string;
  format?: OutputFormat;
}

function getGlobals(cmd: Command): GlobalOpts {
  const opts = cmd.optsWithGlobals<GlobalOpts>();
  return { apiUrl: opts.apiUrl, format: opts.format };
}

export function registerTvCommand(program: Command): void {
  const cmd = program
    .command('tv')
    .description('Controlar el Samsung TV (power, volumen, canal, input, teclas, apps, config)');

  cmd
    .command('status')
    .description('Ver estado del TV: power, volumen, mute, input, app (GET /tv/status)')
    .action(async () => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Consultando estado del TV...').start();
      try {
        const { data } = await client.get('/tv/status');
        spinner.stop();
        // { online: false } significa TV apagado/inalcanzable: se imprime igual, no es error.
        printObject(data, fmt === 'table' ? 'json' : fmt);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('power <state>')
    .description('Prender o apagar el TV: on | off (PUT /tv/power, idempotente)')
    .action(async (state: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      if (state !== 'on' && state !== 'off') {
        fail('El estado debe ser "on" u "off"');
        process.exit(1);
      }
      const on = state === 'on';
      const spinner = ora(on ? 'Prendiendo el TV...' : 'Apagando el TV...').start();
      try {
        const { data } = await client.put('/tv/power', { on });
        spinner.stop();
        if (data?.changed === false) {
          success(`El TV ya estaba ${on ? 'prendido' : 'apagado'}`);
        } else {
          success(on ? 'TV prendido' : 'TV apagado');
        }
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('power-toggle')
    .description('Alternar encendido/apagado (POST /tv/power/toggle)')
    .action(async () => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Alternando power...').start();
      try {
        await client.post('/tv/power/toggle');
        spinner.stop();
        success('Power toggled');
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('volume <level>')
    .description('Setear volumen absoluto 0-100 (PUT /tv/volume)')
    .action(async (level: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const volume = parseInt(level, 10);
      if (Number.isNaN(volume) || volume < 0 || volume > 100) {
        fail('El volumen debe ser un entero entre 0 y 100');
        process.exit(1);
      }
      const spinner = ora(`Seteando volumen a ${volume}...`).start();
      try {
        await client.put('/tv/volume', { volume });
        spinner.stop();
        success(`Volumen seteado a ${volume}`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('volume-up')
    .description('Subir el volumen (POST /tv/volume/up)')
    .action(async () => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Subiendo volumen...').start();
      try {
        await client.post('/tv/volume/up');
        spinner.stop();
        success('Volumen subido');
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('volume-down')
    .description('Bajar el volumen (POST /tv/volume/down)')
    .action(async () => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Bajando volumen...').start();
      try {
        await client.post('/tv/volume/down');
        spinner.stop();
        success('Volumen bajado');
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('mute')
    .description('Mutear el TV (PUT /tv/mute { muted: true })')
    .action(async () => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Muteando...').start();
      try {
        await client.put('/tv/mute', { muted: true });
        spinner.stop();
        success('TV muteado');
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('unmute')
    .description('Desmutear el TV (PUT /tv/mute { muted: false })')
    .action(async () => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Desmuteando...').start();
      try {
        await client.put('/tv/mute', { muted: false });
        spinner.stop();
        success('TV desmuteado');
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('mute-toggle')
    .description('Alternar mute (POST /tv/mute/toggle)')
    .action(async () => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Alternando mute...').start();
      try {
        const { data } = await client.post('/tv/mute/toggle');
        spinner.stop();
        success(`Mute ${data?.muted ? 'activado' : 'desactivado'}`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('channel <numero>')
    .description('Sintonizar un canal por número (PUT /tv/channel)')
    .action(async (numero: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora(`Sintonizando canal ${numero}...`).start();
      try {
        await client.put('/tv/channel', { channel: numero });
        spinner.stop();
        success(`Canal sintonizado: ${numero}`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('channel-up')
    .description('Subir un canal (POST /tv/channel/up)')
    .action(async () => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Subiendo canal...').start();
      try {
        await client.post('/tv/channel/up');
        spinner.stop();
        success('Canal subido');
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('channel-down')
    .description('Bajar un canal (POST /tv/channel/down)')
    .action(async () => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Bajando canal...').start();
      try {
        await client.post('/tv/channel/down');
        spinner.stop();
        success('Canal bajado');
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('input <source>')
    .description('Cambiar de input/fuente: dtv | HDMI1 | HDMI2 | ... (PUT /tv/input)')
    .action(async (source: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora(`Cambiando a input ${source}...`).start();
      try {
        await client.put('/tv/input', { source });
        spinner.stop();
        success(`Input cambiado: ${source}`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('inputs')
    .description('Listar los inputs/fuentes disponibles (GET /tv/inputs)')
    .action(async () => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Trayendo inputs...').start();
      try {
        const { data } = await client.get('/tv/inputs');
        spinner.stop();
        printObject(data, fmt === 'table' ? 'json' : fmt);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('key <tecla>')
    .description('Mandar una tecla del control remoto por id semántico (POST /tv/remote)')
    .action(async (tecla: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora(`Mandando tecla ${tecla}...`).start();
      try {
        await client.post('/tv/remote', { key: tecla });
        spinner.stop();
        success(`Tecla enviada: ${tecla}`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('keys')
    .description('Listar las teclas del control remoto disponibles (GET /tv/remote/keys)')
    .action(async () => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Trayendo teclas...').start();
      try {
        const { data } = await client.get('/tv/remote/keys');
        spinner.stop();
        printObject(data, fmt === 'table' ? 'json' : fmt);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('playback <action>')
    .description('Control de reproducción: play | pause | stop | ... (PUT /tv/playback)')
    .action(async (action: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora(`Ejecutando ${action}...`).start();
      try {
        await client.put('/tv/playback', { action });
        spinner.stop();
        success(`Playback: ${action}`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('track-next')
    .description('Siguiente pista (POST /tv/track/next)')
    .action(async () => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Siguiente pista...').start();
      try {
        await client.post('/tv/track/next');
        spinner.stop();
        success('Siguiente pista');
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('track-prev')
    .description('Pista anterior (POST /tv/track/prev)')
    .action(async () => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Pista anterior...').start();
      try {
        await client.post('/tv/track/prev');
        spinner.stop();
        success('Pista anterior');
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('picture-mode <mode>')
    .description('Setear el modo de imagen (PUT /tv/picture-mode)')
    .action(async (mode: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora(`Seteando modo de imagen ${mode}...`).start();
      try {
        await client.put('/tv/picture-mode', { mode });
        spinner.stop();
        success(`Modo de imagen: ${mode}`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('sound-mode <mode>')
    .description('Setear el modo de sonido (PUT /tv/sound-mode)')
    .action(async (mode: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora(`Seteando modo de sonido ${mode}...`).start();
      try {
        await client.put('/tv/sound-mode', { mode });
        spinner.stop();
        success(`Modo de sonido: ${mode}`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('modes')
    .description('Listar los modos de imagen/sonido disponibles (GET /tv/modes)')
    .action(async () => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Trayendo modos...').start();
      try {
        const { data } = await client.get('/tv/modes');
        spinner.stop();
        printObject(data, fmt === 'table' ? 'json' : fmt);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('app <appId>')
    .description('Abrir una app por su Samsung appId (POST /tv/app/launch)')
    .action(async (appId: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora(`Abriendo app ${appId}...`).start();
      try {
        await client.post('/tv/app/launch', { appId });
        spinner.stop();
        success(`App abierta: ${appId}`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('apps')
    .description('Listar las apps conocidas del TV (GET /tv/apps)')
    .action(async () => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Trayendo apps...').start();
      try {
        const { data } = await client.get('/tv/apps');
        spinner.stop();
        printObject(data, fmt === 'table' ? 'json' : fmt);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('apps-installed')
    .description('Listar solo las apps realmente instaladas (GET /tv/apps/installed)')
    .action(async () => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Trayendo apps instaladas...').start();
      try {
        const { data } = await client.get('/tv/apps/installed');
        spinner.stop();
        printObject(data, fmt === 'table' ? 'json' : fmt);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('ambient-on')
    .description('Activar el modo Ambient (POST /tv/ambient/on)')
    .action(async () => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Activando modo Ambient...').start();
      try {
        await client.post('/tv/ambient/on');
        spinner.stop();
        success('Modo Ambient activado');
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('config [deviceId] [ip]')
    .description(
      'Ver la config (GET /tv/config) o setear el deviceId de SmartThings + IP LAN opcional (PUT /tv/config)',
    )
    .action(async (deviceId?: string, ip?: string) => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      if (!deviceId) {
        const spinner = ora('Trayendo config...').start();
        try {
          const { data } = await client.get('/tv/config');
          spinner.stop();
          printObject(data, fmt === 'table' ? 'json' : fmt);
        } catch (e) {
          spinner.stop();
          fail((e as Error).message);
          process.exit(1);
        }
        return;
      }
      const spinner = ora(`Configurando deviceId ${deviceId}...`).start();
      try {
        await client.put('/tv/config', ip ? { deviceId, ip } : { deviceId });
        spinner.stop();
        success(`Config guardada: deviceId ${deviceId}${ip ? `, ip ${ip}` : ''}`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });
}
