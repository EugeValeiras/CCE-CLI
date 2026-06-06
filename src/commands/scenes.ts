import { Command } from 'commander';
import ora from 'ora';
import { createApiClient } from '../lib/api-client.js';
import { Column, fail, printObject, printRows, success, warn, OutputFormat } from '../lib/format.js';
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
    .description('Activar una escena: aplica el estado a cada luz')
    .action(async (id: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      const spinner = ora('Activando escena...').start();
      try {
        const { data } = await client.get<{ scenes: Scene[] }>('/config/scenes');
        const scene = (data.scenes ?? []).find((s) => s.id === id);
        if (!scene) {
          spinner.stop();
          fail(`Escena no encontrada: ${id}`);
          process.exit(1);
        }
        let ok = 0;
        const failures: string[] = [];
        for (const light of scene.lights) {
          try {
            await client.put(`/devices/${encodeURIComponent(light.lightId)}/state`, {
              on: light.on,
              bri: light.bri,
              ...(light.hue != null ? { hue: light.hue } : {}),
              ...(light.sat != null ? { sat: light.sat } : {}),
              ...(light.ct != null ? { ct: light.ct } : {}),
            });
            ok++;
          } catch (e) {
            failures.push(`${light.lightId}: ${(e as Error).message}`);
          }
        }
        spinner.stop();
        success(`Escena activada: ${ok} luces`);
        if (failures.length > 0) {
          warn(`${failures.length} luces fallaron:`);
          for (const f of failures) warn(`  ${f}`);
        }
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exit(1);
      }
    });
}
