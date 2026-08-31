import { Command } from 'commander';
import * as fs from 'fs';
import ora from 'ora';
import { createApiClient } from '../lib/api-client.js';
import { Column, fail, printObject, printRows, success } from '../lib/format.js';
import { resolveFormat } from '../lib/user-config.js';
import { countSteps, describeTriggers, renderAutomation } from '../lib/flow-format.js';
import { Automation } from '../types/api.js';

interface GlobalOpts {
  apiUrl?: string;
  format?: 'table' | 'json' | 'csv';
}

function getGlobals(cmd: Command): GlobalOpts {
  return cmd.optsWithGlobals<GlobalOpts>();
}

/**
 * CCE#64 — Las columnas describen el modelo de FLUJO.
 *
 * `Trigger`/`Actions` mostraban `trigger.type` y `actions.length`, que hablaban
 * del modelo plano: una automatización con dos sensores decía "sensor" a secas,
 * y una con ramas o esperas contaba sólo las acciones de primer nivel. Ahora
 * `Triggers` sale de `when` (con la cantidad cuando hay varios sensores) y
 * `Steps` cuenta el árbol entero, ramas incluidas.
 *
 * `Source` se va: en la casa TODAS las automatizaciones son `custom`, y en el
 * modelo nuevo el source es una acción más del flujo, no una categoría.
 */
const autoCols: Column<Automation>[] = [
  { header: 'ID', get: (a) => a.id },
  { header: 'Name', get: (a) => a.name },
  { header: 'Enabled', get: (a) => a.enabled },
  { header: 'Triggers', get: (a) => describeTriggers(a) },
  { header: 'Steps', get: (a) => countSteps(a.flow) },
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
        // En `table` (el default) se muestra el FLUJO indentado; el JSON crudo
        // de un árbol con ramas y esperas no se lee en una terminal. Con
        // --format json/csv sale el objeto entero, que es lo que espera un
        // script que canaliza la salida.
        if (fmt === 'table') console.log(renderAutomation(a));
        else printObject(a, fmt);
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
    .description('Ejecutar una automatización (server-side: resuelve TODOS los sources)')
    .action(async (id: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      try {
        // Server-side a propósito: el run client-side viejo ignoraba el source
        // (una automation source:group/hueRoom/scene ejecutaba CERO acciones y
        // reportaba éxito) y las acciones on:'group' caían al path device roto.
        // El server la corre entera por el chokepoint, con origin en el ledger.
        await client.post(`/automations/${encodeURIComponent(id)}/run`, {});
        success(`Automatización ${id} ejecutada (server-side).`);
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
