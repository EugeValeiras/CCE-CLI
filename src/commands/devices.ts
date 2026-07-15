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
    .description('Eliminar dispositivo. Acepta dev_* canónico (borra todos sus bindings) o un bindingId')
    .option('--forget', 'Solo sacarlo de la app (ignore-list, reversible); no desemparejar del proveedor')
    .option('--force', 'Desemparejar aunque comparta nodo Matter con otros dispositivos (peligroso)')
    .action(async (id: string, opts: { forget?: boolean; force?: boolean }) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const q = new URLSearchParams();
      if (opts.forget) q.set('decommission', 'false');
      if (opts.force) q.set('force', 'true');
      const qs = q.toString() ? `?${q.toString()}` : '';
      const spinner = ora(`Eliminando ${id}...`).start();
      try {
        const { data } = await client.delete(`/devices/${encodeURIComponent(id)}${qs}`);
        spinner.stop();
        const bindings: Array<{ bindingId: string; provider: string; action: string; reason?: string }> =
          data.bindings ?? [];
        for (const b of bindings) {
          const tag =
            b.action === 'decommissioned' ? 'desemparejado'
            : b.action === 'forgotten' ? 'olvidado'
            : 'falló';
          const reason = b.reason ? ` (${b.reason})` : '';
          process.stdout.write(`  ${b.provider}:${b.bindingId} → ${tag}${reason}\n`);
        }
        if (data.purgedRefs) process.stdout.write(`  refs de config limpiadas: ${data.purgedRefs}\n`);
        if (data.success) success(`Eliminado: ${id}`);
        else fail(`No se pudo eliminar: ${id}`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('prune')
    .description('Limpieza masiva de huérfanos. Por defecto dry-run (solo lista)')
    .option('--scope <scope>', "dead (todos los bindings inalcanzables) | unplaced (sin ubicar en planos) | all", 'dead')
    .option('--apply', 'Ejecutar de verdad (sin esto, solo lista los candidatos)')
    .option('--forget', 'Olvidar (ignore-list) en vez de desemparejar del proveedor')
    .option('--force', 'Desemparejar aunque comparta nodo Matter (peligroso)')
    .action(async (opts: { scope?: string; apply?: boolean; forget?: boolean; force?: boolean }) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const dryRun = !opts.apply;
      const spinner = ora(dryRun ? 'Buscando huérfanos...' : 'Limpiando...').start();
      try {
        const { data } = await client.post('/devices/prune', {
          scope: opts.scope,
          dryRun,
          decommission: !opts.forget,
          force: !!opts.force,
        });
        spinner.stop();
        const candidates: Array<{ id: string; name: string; type: string; reachable: boolean }> =
          data.candidates ?? [];
        if (candidates.length === 0) {
          success(`Sin candidatos para scope="${data.scope}".`);
          return;
        }
        process.stdout.write(`Candidatos (scope=${data.scope}):\n`);
        for (const c of candidates) {
          process.stdout.write(`  ${c.id}  ${c.name}  [${c.type}]  reach=${c.reachable}\n`);
        }
        if (dryRun) {
          process.stdout.write(`\n${candidates.length} dispositivo(s). Corré con --apply para eliminarlos.\n`);
        } else {
          const removed: Array<{ removed: boolean }> = data.removed ?? [];
          success(`Eliminados ${removed.filter((r) => r.removed).length}/${candidates.length}.`);
        }
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
    .command('action <id> <verb> [args...]')
    .description(
      'Ejecutar una acción genérica por capability: setVolume volume=15, mute muted=true, ' +
        'setInput source=HDMI2, launchApp appId=netflix, setChannel channel:=7, ' +
        'volumeUp, play/pause/stop/next/prev, lock/unlock (--confirm). ' +
        'Usá key:=value para forzar string (ej. un canal numérico: channel:=7).',
    )
    .option('--confirm', 'Confirmar un verbo sensible (ej. unlock)')
    .action(async (id: string, verb: string, args: string[], opts: { confirm?: boolean }) => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      // Parseo key=value con coerción de tipo: el catálogo valida TIPO
      // (number/boolean/string), así que un volume='15' string daría 400.
      // Sintaxis explícita key:=value → fuerza string SIN coerción, para args
      // string-typed con valor numérico (ej. setChannel channel:=7): sin esto
      // coerceArg('7') mandaría {channel:7} y el catálogo lo rechaza con 400.
      const body: Record<string, unknown> = {};
      for (const raw of args ?? []) {
        const eq = raw.indexOf('=');
        if (eq === -1) {
          fail(`Argumento inválido '${raw}': usá formato key=value (ej. volume=15) o key:=value para forzar string.`);
          process.exit(1);
        }
        if (eq > 0 && raw[eq - 1] === ':') {
          body[raw.slice(0, eq - 1)] = raw.slice(eq + 1);
        } else {
          body[raw.slice(0, eq)] = coerceArg(raw.slice(eq + 1));
        }
      }
      if (opts.confirm) body.confirm = true;
      const spinner = ora(`Ejecutando ${verb} en ${id}...`).start();
      try {
        const { data } = await client.post(
          `/devices/${encodeURIComponent(id)}/actions/${encodeURIComponent(verb)}`,
          body,
        );
        spinner.stop();
        success(`${verb} → ${id}`);
        printObject(data, fmt === 'table' ? 'json' : fmt);
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

/** Coerción para args key=value de `devices action`: number → boolean → string. */
function coerceArg(v: string): number | boolean | string {
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}
