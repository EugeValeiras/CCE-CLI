import { Command } from 'commander';
import ora from 'ora';
import { createApiClient, resolveHueHeaders } from '../lib/api-client.js';
import { fail, info, printObject, success } from '../lib/format.js';
import { resolveFormat } from '../lib/user-config.js';

interface GlobalOpts {
  apiUrl?: string;
  format?: 'table' | 'json' | 'csv';
}

function getGlobals(cmd: Command): GlobalOpts {
  return cmd.optsWithGlobals<GlobalOpts>();
}

export function registerHueCommand(program: Command): void {
  const cmd = program
    .command('hue')
    .description('Operaciones específicas del Hue Bridge (discover, sensors, disconnect, ...)');

  cmd
    .command('discover')
    .description('Descubrir Hue Bridges en la red local (GET /api/hue/discover)')
    .action(async () => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Buscando bridges...').start();
      try {
        const { data } = await client.get('/hue/discover');
        spinner.stop();
        if (Array.isArray(data) && data.length === 0) {
          info('No se encontraron bridges.');
          return;
        }
        printObject(data, fmt === 'table' ? 'json' : fmt);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('auth')
    .description(
      'Autenticar con un bridge (presioná el link button ANTES de correr el comando)',
    )
    .requiredOption('--bridge-ip <ip>', 'IP del bridge')
    .option('--app <name>', 'Nombre de la app', 'cce-cli')
    .action(async (opts: { bridgeIp: string; app: string }) => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora(`Pidiendo apiKey a ${opts.bridgeIp}...`).start();
      try {
        const { data } = await client.post('/hue/auth', {
          bridgeIp: opts.bridgeIp,
          appName: opts.app,
        });
        spinner.stop();
        success('Autenticación exitosa.');
        printObject(data, fmt === 'table' ? 'json' : fmt);
        info(
          'Guardá las credenciales con:\n' +
            `  cce config set providers.hue.bridgeIp ${opts.bridgeIp}\n` +
            `  cce config set providers.hue.apiKey <apiKey>`,
        );
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('sensors')
    .description('Listar sensores Hue (switches, motion, contact, ...)')
    .action(async () => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Trayendo sensores Hue...').start();
      try {
        const headers = await resolveHueHeaders(client);
        const { data } = await client.get('/hue/sensors', { headers });
        spinner.stop();
        printObject(data, fmt === 'table' ? 'json' : fmt);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('simulate-button <sensorId>')
    .description('Simula un click en un sensor Hue (dispara automatizaciones)')
    .requiredOption(
      '--key <n>',
      'Tipo de click: 0=single, 1=double, 2=long',
      (v) => parseInt(v, 10),
    )
    .option(
      '--outlet <n>',
      'Botón físico (0=botón 1, 1=botón 2, ...). Sólo para remotes multi-botón',
      (v) => parseInt(v, 10),
    )
    .action(
      async (
        sensorId: string,
        opts: { key: number; outlet?: number },
      ) => {
        const g = getGlobals(cmd);
        const client = createApiClient({ apiUrl: g.apiUrl });
        try {
          if (Number.isNaN(opts.key) || opts.key < 0 || opts.key > 2) {
            throw new Error('--key debe ser 0 (single), 1 (double) o 2 (long)');
          }
          const body: { key: number; outlet?: number } = { key: opts.key };
          if (opts.outlet !== undefined) body.outlet = opts.outlet;
          await client.post(
            `/hue/sensors/${encodeURIComponent(sensorId)}/simulate-button`,
            body,
          );
          success(`Click simulado en ${sensorId} (key=${opts.key}${opts.outlet !== undefined ? `, outlet=${opts.outlet}` : ''})`);
        } catch (e) {
          fail((e as Error).message);
          process.exit(1);
        }
      },
    );

  cmd
    .command('disconnect')
    .description('Desconectar el bridge Hue del backend (DELETE /api/hue/disconnect)')
    .option('-y, --yes', 'No pedir confirmación')
    .action(async (opts: { yes?: boolean }) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      if (!opts.yes) {
        fail(
          'Comando destructivo. Pasá --yes para confirmar (limpia el estado del bridge en el backend).',
        );
        process.exit(1);
      }
      const spinner = ora('Desconectando bridge...').start();
      try {
        await client.delete('/hue/disconnect');
        spinner.stop();
        success('Bridge desconectado.');
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });
}
