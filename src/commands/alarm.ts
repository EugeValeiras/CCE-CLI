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

export function registerAlarmCommand(program: Command): void {
  const cmd = program.command('alarm').description('Gestionar la alarma de la casa');

  cmd
    .command('status')
    .description('Ver estado de la alarma (GET /config/alarm-armed)')
    .action(async () => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      try {
        const { data } = await client.get('/config/alarm-armed');
        printObject(data, fmt === 'table' ? 'json' : fmt);
      } catch (e) {
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('arm')
    .description('Armar la alarma (PUT /config/alarm-armed { armed: true })')
    .action(async () => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Armando alarma...').start();
      try {
        await client.put('/config/alarm-armed', { armed: true });
        spinner.stop();
        success('Alarma armada');
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('disarm')
    .description('Desarmar la alarma (PUT /config/alarm-armed { armed: false })')
    .action(async () => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Desarmando alarma...').start();
      try {
        await client.put('/config/alarm-armed', { armed: false });
        spinner.stop();
        success('Alarma desarmada');
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });
}
