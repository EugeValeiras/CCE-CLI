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

export function registerJblCommand(program: Command): void {
  const cmd = program
    .command('jbl')
    .description('Controlar la barra de sonido JBL (volumen, mute, power, config)');

  cmd
    .command('status')
    .description('Ver estado de la barra: volumen, mute, power (GET /jbl/status)')
    .action(async () => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Consultando estado de la barra...').start();
      try {
        const { data } = await client.get('/jbl/status');
        spinner.stop();
        // { online: false } significa barra inalcanzable: se imprime igual, no es error.
        printObject(data, fmt === 'table' ? 'json' : fmt);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('volume <level>')
    .description('Setear volumen absoluto 0-33 (escala del display, PUT /jbl/volume)')
    .action(async (level: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const volume = parseInt(level, 10);
      if (Number.isNaN(volume) || volume < 0 || volume > 33) {
        fail('El volumen debe ser un entero entre 0 y 33');
        process.exit(1);
      }
      const spinner = ora(`Seteando volumen a ${volume}...`).start();
      try {
        await client.put('/jbl/volume', { volume });
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
    .description('Subir el volumen (POST /jbl/volume/up)')
    .option('--step <n>', 'Cuánto subir (default 5)', (v) => parseInt(v, 10), 5)
    .action(async (opts: { step: number }) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      if (Number.isNaN(opts.step)) {
        fail('--step debe ser un número entero');
        process.exit(1);
      }
      const spinner = ora(`Subiendo volumen (+${opts.step})...`).start();
      try {
        await client.post('/jbl/volume/up', { step: opts.step });
        spinner.stop();
        success(`Volumen subido (+${opts.step})`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('volume-down')
    .description('Bajar el volumen (POST /jbl/volume/down)')
    .option('--step <n>', 'Cuánto bajar (default 5)', (v) => parseInt(v, 10), 5)
    .action(async (opts: { step: number }) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      if (Number.isNaN(opts.step)) {
        fail('--step debe ser un número entero');
        process.exit(1);
      }
      const spinner = ora(`Bajando volumen (-${opts.step})...`).start();
      try {
        await client.post('/jbl/volume/down', { step: opts.step });
        spinner.stop();
        success(`Volumen bajado (-${opts.step})`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('mute')
    .description('Mutear la barra (PUT /jbl/mute { muted: true })')
    .action(async () => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Muteando...').start();
      try {
        await client.put('/jbl/mute', { muted: true });
        spinner.stop();
        success('Barra muteada');
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('unmute')
    .description('Desmutear la barra (PUT /jbl/mute { muted: false })')
    .action(async () => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Desmuteando...').start();
      try {
        await client.put('/jbl/mute', { muted: false });
        spinner.stop();
        success('Barra desmuteada');
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('mute-toggle')
    .description('Alternar mute (POST /jbl/mute/toggle)')
    .action(async () => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Alternando mute...').start();
      try {
        const { data } = await client.post('/jbl/mute/toggle');
        spinner.stop();
        success(`Mute ${data?.muted ? 'activado' : 'desactivado'}`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('power <state>')
    .description('Prender o apagar la barra: on | off (PUT /jbl/power, idempotente)')
    .action(async (state: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      if (state !== 'on' && state !== 'off') {
        fail('El estado debe ser "on" u "off"');
        process.exit(1);
      }
      const on = state === 'on';
      const spinner = ora(on ? 'Prendiendo la barra...' : 'Apagando la barra...').start();
      try {
        const { data } = await client.put('/jbl/power', { on });
        spinner.stop();
        if (data?.changed === false) {
          success(`La barra ya estaba ${on ? 'prendida' : 'apagada'}`);
        } else {
          success(on ? 'Barra prendida' : 'Barra apagada');
        }
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('power-toggle')
    .description('Alternar encendido/apagado (POST /jbl/power/toggle)')
    .action(async () => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Alternando power...').start();
      try {
        await client.post('/jbl/power/toggle');
        spinner.stop();
        success('Power toggled');
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('radio [nombre]')
    .description(
      'Poner una radio guardada por nombre, o la primera si no pasás nombre (POST /jbl/radio/play — también despierta la barra)',
    )
    .action(async (nombre?: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Poniendo la radio...').start();
      try {
        const { data } = await client.post('/jbl/radio/play', nombre ? { name: nombre } : {});
        spinner.stop();
        success(`Sonando: ${data?.name ?? 'radio'}`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('radio-list')
    .description('Listar las radios guardadas (GET /jbl/radios)')
    .action(async () => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Trayendo radios...').start();
      try {
        const { data } = await client.get('/jbl/radios');
        spinner.stop();
        printObject(data, fmt === 'table' ? 'json' : fmt);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('radio-delete <nombre>')
    .description('Borrar una radio guardada por nombre (DELETE /jbl/radios/:name)')
    .action(async (nombre: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora(`Borrando "${nombre}"...`).start();
      try {
        await client.delete(`/jbl/radios/${encodeURIComponent(nombre)}`);
        spinner.stop();
        success(`Radio borrada: ${nombre}`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('radio-info')
    .description('Ver qué radio está guardada para el botón (GET /jbl/radio)')
    .action(async () => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Trayendo radio guardada...').start();
      try {
        const { data } = await client.get('/jbl/radio');
        spinner.stop();
        printObject(data, fmt === 'table' ? 'json' : fmt);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('radio-save')
    .description('Guardar lo que está sonando ahora como la radio del botón (POST /jbl/radio/save)')
    .action(async () => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Guardando la radio actual...').start();
      try {
        const { data } = await client.post('/jbl/radio/save');
        spinner.stop();
        success(`Radio guardada: ${data?.name ?? 'OK'}`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('config [ip]')
    .description(
      'Ver la IP configurada (GET /jbl/config) o setearla pasando una IP (PUT /jbl/config)',
    )
    .action(async (ip?: string) => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      if (!ip) {
        const spinner = ora('Trayendo config...').start();
        try {
          const { data } = await client.get('/jbl/config');
          spinner.stop();
          printObject(data, fmt === 'table' ? 'json' : fmt);
        } catch (e) {
          spinner.stop();
          fail((e as Error).message);
          process.exit(1);
        }
        return;
      }
      const spinner = ora(`Configurando IP ${ip}...`).start();
      try {
        await client.put('/jbl/config', { ip });
        spinner.stop();
        success(`IP configurada: ${ip}`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });
}
