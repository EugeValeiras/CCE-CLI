import { Command } from 'commander';
import * as fs from 'fs';
import ora from 'ora';
import { createApiClient } from '../lib/api-client.js';
import { Column, fail, info, printObject, printRows, success } from '../lib/format.js';
import { resolveFormat } from '../lib/user-config.js';
import { Automation, AutomationAction } from '../types/api.js';

interface GlobalOpts {
  apiUrl?: string;
  format?: 'table' | 'json' | 'csv';
}

function getGlobals(cmd: Command): GlobalOpts {
  return cmd.optsWithGlobals<GlobalOpts>();
}

const autoCols: Column<Automation>[] = [
  { header: 'ID', get: (a) => a.id },
  { header: 'Name', get: (a) => a.name },
  { header: 'Enabled', get: (a) => a.enabled },
  { header: 'Source', get: (a) => a.source },
  { header: 'Trigger', get: (a) => a.trigger?.type ?? '' },
  { header: 'Actions', get: (a) => a.actions?.length ?? 0 },
];

export function registerAutomationsCommand(program: Command): void {
  const cmd = program.command('automations').description('Gestionar automatizaciones');

  cmd
    .command('list')
    .description('Listar automatizaciones')
    .action(async () => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      try {
        const { data } = await client.get<Automation[]>('/config/automations');
        printRows(data, autoCols, fmt);
      } catch (e) {
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('show <id>')
    .description('Mostrar detalle de una automatización')
    .action(async (id: string) => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      try {
        const { data } = await client.get<Automation[]>('/config/automations');
        const a = data.find((x) => x.id === id);
        if (!a) {
          fail(`Automatización no encontrada: ${id}`);
          process.exit(1);
        }
        printObject(a, fmt === 'table' ? 'json' : fmt);
      } catch (e) {
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('enable <id>')
    .description('Habilitar automatización')
    .action((id) => setEnabled(cmd, id, true));

  cmd
    .command('disable <id>')
    .description('Deshabilitar automatización')
    .action((id) => setEnabled(cmd, id, false));

  cmd
    .command('run <id>')
    .description('Ejecutar acciones de una automatización manualmente (vía PUT /devices/:id/state)')
    .action(async (id: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      try {
        const { data } = await client.get<Automation[]>('/config/automations');
        const a = data.find((x) => x.id === id);
        if (!a) {
          fail(`Automatización no encontrada: ${id}`);
          process.exit(1);
        }
        info(`Ejecutando ${a.actions.length} acciones de "${a.name}"...`);
        let ok = 0;
        let errCount = 0;
        for (const act of a.actions) {
          try {
            await runAction(client, act);
            ok++;
          } catch (e) {
            errCount++;
            fail(`Action lightId=${act.lightId}: ${(e as Error).message}`);
          }
        }
        success(`Hechas ${ok} acciones, ${errCount} fallidas.`);
      } catch (e) {
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('create')
    .description('Crear/agregar automatización desde archivo JSON')
    .requiredOption('-f, --file <path>', 'Archivo JSON con una Automation o un array')
    .action(async (opts: { file: string }) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      try {
        const raw = fs.readFileSync(opts.file, 'utf-8');
        const parsed = JSON.parse(raw);
        const toAdd: Automation[] = Array.isArray(parsed) ? parsed : [parsed];
        const { data: current } = await client.get<Automation[]>('/config/automations');
        const byId = new Map(current.map((a) => [a.id, a]));
        for (const a of toAdd) byId.set(a.id, a);
        await client.put('/config/automations', Array.from(byId.values()));
        success(`Guardadas: ${toAdd.map((a) => a.id).join(', ')}`);
      } catch (e) {
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('delete <id>')
    .description('Eliminar una automatización')
    .action(async (id: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      try {
        const { data } = await client.get<Automation[]>('/config/automations');
        const next = data.filter((a) => a.id !== id);
        if (next.length === data.length) {
          fail(`No existe automatización ${id}`);
          process.exit(1);
        }
        await client.put('/config/automations', next);
        success(`Eliminada: ${id}`);
      } catch (e) {
        fail((e as Error).message);
        process.exit(1);
      }
    });
}

async function setEnabled(cmd: Command, id: string, enabled: boolean): Promise<void> {
  const g = getGlobals(cmd);
  const client = createApiClient({ apiUrl: g.apiUrl });
  const spinner = ora(`${enabled ? 'Habilitando' : 'Deshabilitando'} ${id}...`).start();
  try {
    const { data } = await client.get<Automation[]>('/config/automations');
    const target = data.find((a) => a.id === id);
    if (!target) {
      spinner.stop();
      fail(`No existe automatización ${id}`);
      process.exit(1);
    }
    target.enabled = enabled;
    await client.put('/config/automations', data);
    spinner.stop();
    success(`${id} ${enabled ? 'habilitada' : 'deshabilitada'}`);
  } catch (e) {
    spinner.stop();
    fail((e as Error).message);
    process.exit(1);
  }
}

async function runAction(client: ReturnType<typeof createApiClient>, act: AutomationAction): Promise<void> {
  if (act.on === 'notification' || act.on === 'alarm') {
    info(`(Skipped) action tipo "${act.on}" (requiere ejecución server-side)`);
    return;
  }
  const body: Record<string, unknown> = {};
  if (act.on === 'toggle' || act.on === 'bri_up' || act.on === 'bri_down') {
    body.on = act.on;
  } else if (typeof act.on === 'boolean') {
    body.on = act.on;
  }
  if (act.bri !== undefined) body.bri = act.bri;
  if (act.briDelta !== undefined) body.briDelta = act.briDelta;
  if (act.hue !== undefined) body.hue = act.hue;
  if (act.sat !== undefined) body.sat = act.sat;
  if (act.ct !== undefined) body.ct = act.ct;
  await client.put(`/devices/${encodeURIComponent(act.lightId)}/state`, body);
}
