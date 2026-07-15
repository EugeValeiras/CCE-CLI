import { Command } from 'commander';
import ora from 'ora';
import { createApiClient } from '../lib/api-client.js';
import { Column, fail, printObject, printRows, success, OutputFormat } from '../lib/format.js';
import { resolveFormat } from '../lib/user-config.js';
import { Scene } from '../types/api.js';

interface GlobalOpts {
  apiUrl?: string;
  format?: OutputFormat;
}

function getGlobals(cmd: Command): GlobalOpts {
  const opts = cmd.optsWithGlobals<GlobalOpts>();
  return { apiUrl: opts.apiUrl, format: opts.format };
}

const sceneColumns: Column<Scene>[] = [
  { header: 'ID', get: (s) => s.id },
  { header: 'Name', get: (s) => s.name },
  { header: 'Lights', get: (s) => s.lights?.length ?? 0 },
];

export function registerScenesCommand(program: Command): void {
  const cmd = program.command('scenes').description('Gestionar escenas');

  cmd
    .command('list')
    .description('Listar escenas (GET /config/scenes)')
    .action(async () => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });
      try {
        const { data } = await client.get<{ scenes: Scene[] }>('/config/scenes');
        const scenes = data.scenes ?? [];
        if (fmt === 'json') {
          printObject(scenes, 'json');
          return;
        }
        printRows(scenes, sceneColumns, fmt);
      } catch (e) {
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('activate <id>')
    .description('Activar una escena SERVER-SIDE (luces + entries del "modo cine": TV/HDMI/JBL)')
    .action(async (id: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Activando escena...').start();
      try {
        // F14: el server corre lights[] + entries[] de una sola pasada y pasa
        // por el chokepoint sensitive (un verbo 'unlock' en una entry nunca se
        // ejecuta). Antes el CLI iteraba client-side scene.lights, con lo que
        // el "modo cine" (TV/HDMI2/JBL) nunca se disparaba. Read-both: escenas
        // viejas solo-lights corren igual (executeScene ejecuta lights[]).
        await client.post(`/config/scenes/${encodeURIComponent(id)}/run`, {});
        spinner.stop();
        success(`Escena activada: ${id}`);
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });
}
