import { Command } from 'commander';
import ora from 'ora';
import { createApiClient } from '../lib/api-client.js';
import { Column, fail, printObject, printRows, success, warn, OutputFormat } from '../lib/format.js';
import { resolveFormat } from '../lib/user-config.js';
import { LightGroup, MergedDevice } from '../types/api.js';

interface GlobalOpts {
  apiUrl?: string;
  format?: OutputFormat;
}

function getGlobals(cmd: Command): GlobalOpts {
  const opts = cmd.optsWithGlobals<GlobalOpts>();
  return { apiUrl: opts.apiUrl, format: opts.format };
}

const groupColumns: Column<LightGroup>[] = [
  { header: 'ID', get: (gr) => gr.id },
  { header: 'Name', get: (gr) => gr.name },
  { header: 'Lights', get: (gr) => gr.lightIds?.length ?? 0 },
];

export function registerGroupsCommand(program: Command): void {
  const cmd = program.command('groups').description('Gestionar grupos de luces');

  cmd
    .command('list')
    .description('Listar grupos (GET /config/groups)')
    .action(async () => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      try {
        const { data } = await client.get<{ groups: LightGroup[] }>('/config/groups');
        const groups = data.groups ?? [];
        if (fmt === 'json') {
          printObject(groups, 'json');
          return;
        }
        printRows(groups, groupColumns, fmt);
      } catch (e) {
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('on <id>')
    .description('Encender un grupo (--bri/--hue/--sat/--ct opcionales)')
    .option('--bri <n>', 'Brillo (1-254)', parseIntOpt)
    .option('--hue <n>', 'Hue (0-65535)', parseIntOpt)
    .option('--sat <n>', 'Saturación (0-254)', parseIntOpt)
    .option('--ct <n>', 'Color temp en mireds (153-500)', parseIntOpt)
    .action((id: string, opts: Record<string, unknown>) => setGroup(cmd, id, 'on', opts));

  cmd
    .command('off <id>')
    .description('Apagar un grupo')
    .action((id: string) => setGroup(cmd, id, 'off', {}));

  cmd
    .command('toggle <id>')
    .description('Alternar un grupo (on si alguna está apagada, off si todas encendidas)')
    .option('--bri <n>', 'Brillo (1-254)', parseIntOpt)
    .option('--hue <n>', 'Hue (0-65535)', parseIntOpt)
    .option('--sat <n>', 'Saturación (0-254)', parseIntOpt)
    .option('--ct <n>', 'Color temp en mireds (153-500)', parseIntOpt)
    .action((id: string, opts: Record<string, unknown>) => setGroup(cmd, id, 'toggle', opts));
}

async function setGroup(
  cmd: Command,
  id: string,
  mode: 'on' | 'off' | 'toggle',
  opts: Record<string, unknown>,
): Promise<void> {
  const g = getGlobals(cmd);
  const client = createApiClient({ apiUrl: g.apiUrl });
  const spinner = ora(`${mode === 'off' ? 'Apagando' : mode === 'on' ? 'Encendiendo' : 'Alternando'} grupo...`).start();
  try {
    const { data } = await client.get<{ groups: LightGroup[] }>('/config/groups');
    const group = (data.groups ?? []).find((gr) => gr.id === id);
    if (!group) {
      spinner.stop();
      fail(`Grupo no encontrado: ${id}`);
      process.exit(1);
    }

    let desiredOn: boolean;
    if (mode === 'on') {
      desiredOn = true;
    } else if (mode === 'off') {
      desiredOn = false;
    } else {
      const { data: merged } = await client.get<MergedDevice[]>('/devices/merged');
      const anyOn = group.lightIds.some((lid) => merged.find((d) => d.id === lid)?.state?.on);
      desiredOn = !anyOn;
    }

    const flags: Record<string, unknown> = {};
    if (desiredOn) {
      if (opts.bri !== undefined) flags.bri = opts.bri;
      if (opts.hue !== undefined) flags.hue = opts.hue;
      if (opts.sat !== undefined) flags.sat = opts.sat;
      if (opts.ct !== undefined) flags.ct = opts.ct;
    }

    let ok = 0;
    const failures: string[] = [];
    for (const lid of group.lightIds) {
      try {
        await client.put(`/devices/${encodeURIComponent(lid)}/state`, { on: desiredOn, ...flags });
        ok++;
      } catch (e) {
        failures.push(`${lid}: ${(e as Error).message}`);
      }
    }
    spinner.stop();
    success(`Grupo ${group.name}: ${ok} luces -> ${desiredOn ? 'on' : 'off'}`);
    if (failures.length > 0) {
      warn(`${failures.length} luces fallaron:`);
      for (const f of failures) warn(`  ${f}`);
    }
  } catch (e) {
    spinner.stop();
    fail((e as Error).message);
    process.exit(1);
  }
}

function parseIntOpt(v: string): number {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Valor entero inválido: ${v}`);
  return n;
}
