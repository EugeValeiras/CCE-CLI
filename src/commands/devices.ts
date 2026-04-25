import { Command } from 'commander';
import ora from 'ora';
import { createApiClient } from '../lib/api-client.js';
import { Column, printObject, printRows, success, fail, OutputFormat } from '../lib/format.js';
import { resolveFormat } from '../lib/user-config.js';
import { MergedDevice } from '../types/api.js';

interface GlobalOpts {
  apiUrl?: string;
  format?: OutputFormat;
}

function getGlobals(cmd: Command): GlobalOpts {
  const opts = cmd.optsWithGlobals<GlobalOpts>();
  return { apiUrl: opts.apiUrl, format: opts.format };
}

const deviceColumns: Column<MergedDevice>[] = [
  { header: 'ID', get: (d) => d.id },
  { header: 'Name', get: (d) => d.name },
  { header: 'Type', get: (d) => d.type },
  { header: 'Manufacturer', get: (d) => d.manufacturer },
  { header: 'On', get: (d) => d.state?.on ?? false },
  { header: 'Bri', get: (d) => d.state?.bri ?? '' },
  { header: 'Reach', get: (d) => d.state?.reachable ?? false },
  { header: 'Bindings', get: (d) => d.bindings.map((b) => b.provider).join(',') },
];

export function registerDevicesCommand(program: Command): void {
  const cmd = program.command('devices').description('Gestionar dispositivos');

  cmd
    .command('list')
    .description('Listar dispositivos mergeados')
    .option('--raw', 'Mostrar bindings raw con info de merge')
    .action(async (opts: { raw?: boolean }) => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Listando dispositivos...').start();
      try {
        if (opts.raw) {
          const { data } = await client.get('/devices/raw');
          spinner.stop();
          printObject(data, fmt);
          return;
        }
        const { data } = await client.get<MergedDevice[]>('/devices/merged');
        spinner.stop();
        printRows(data, deviceColumns, fmt);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('show <id>')
    .description('Mostrar detalle de un dispositivo')
    .action(async (id: string) => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      try {
        const { data } = await client.get<MergedDevice[]>('/devices/merged');
        const device = data.find((d) => d.id === id || d.bindings.some((b) => b.bindingId === id));
        if (!device) {
          fail(`Dispositivo no encontrado: ${id}`);
          process.exit(1);
        }
        printObject(device, fmt === 'table' ? 'json' : fmt);
      } catch (e) {
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('state <id>')
    .description('Cambiar estado: --on/--off, --bri, --hue, --sat, --ct')
    .option('--on', 'Encender')
    .option('--off', 'Apagar')
    .option('--toggle', 'Alternar')
    .option('--bri <n>', 'Brillo (1-254)', parseIntOpt)
    .option('--hue <n>', 'Hue (0-65535)', parseIntOpt)
    .option('--sat <n>', 'Saturación (0-254)', parseIntOpt)
    .option('--ct <n>', 'Color temp en mireds (153-500)', parseIntOpt)
    .action(async (id: string, opts: Record<string, unknown>) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const body: Record<string, unknown> = {};
      if (opts.on) body.on = true;
      if (opts.off) body.on = false;
      if (opts.toggle) body.on = 'toggle';
      if (opts.bri !== undefined) body.bri = opts.bri;
      if (opts.hue !== undefined) body.hue = opts.hue;
      if (opts.sat !== undefined) body.sat = opts.sat;
      if (opts.ct !== undefined) body.ct = opts.ct;
      if (Object.keys(body).length === 0) {
        fail('Debe pasar al menos un flag (--on/--off/--toggle/--bri/--hue/--sat/--ct).');
        process.exit(1);
      }
      const spinner = ora(`Cambiando estado de ${id}...`).start();
      try {
        const { data } = await client.put(`/devices/${encodeURIComponent(id)}/state`, body);
        spinner.stop();
        success(`Estado actualizado (binding: ${data.usedBindingId ?? 'n/a'})`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('delete <id>')
    .description('Eliminar dispositivo de su proveedor')
    .action(async (id: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora(`Eliminando ${id}...`).start();
      try {
        const { data } = await client.delete(`/devices/${encodeURIComponent(id)}`);
        spinner.stop();
        if (data.success) success(`Eliminado: ${id}`);
        else fail(`No se pudo eliminar: ${id}`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('merge <targetId> <sourceId>')
    .description('Merge manual: mueve sourceId dentro de targetId')
    .action(async (targetDeviceId: string, sourceDeviceId: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Merging...').start();
      try {
        await client.post('/devices/merge', { targetDeviceId, sourceDeviceId });
        spinner.stop();
        success(`${sourceDeviceId} → ${targetDeviceId}`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('split <id> <bindingId>')
    .description('Separar un binding de un dispositivo mergeado')
    .action(async (id: string, bindingId: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Splitting...').start();
      try {
        await client.post(`/devices/${encodeURIComponent(id)}/split`, { bindingId });
        spinner.stop();
        success(`Binding ${bindingId} separado de ${id}`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('prefer <id> <bindingId>')
    .description('Establecer binding preferido para comandos')
    .action(async (id: string, bindingId: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      try {
        await client.put(`/devices/${encodeURIComponent(id)}/preferred-binding`, { bindingId });
        success(`Preferido ${bindingId} para ${id}`);
      } catch (e) {
        fail((e as Error).message);
        process.exit(1);
      }
    });
}

function parseIntOpt(v: string): number {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Valor entero inválido: ${v}`);
  return n;
}
