import { Command } from 'commander';
import ora from 'ora';
import { createApiClient } from '../lib/api-client.js';
import { fail, printObject, success, warn, OutputFormat } from '../lib/format.js';
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
        avisarModoPrueba(data);
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
        // "Alarma armada" a secas mientras el disparo está degradado es la
        // trampa que el modo prueba puede tender (CCE#122): el estado se
        // relee para poder decirlo acá mismo.
        try {
          const { data } = await client.get('/config/alarm-armed');
          avisarModoPrueba(data);
        } catch {
          warn('No se pudo confirmar si el modo prueba está activo (`cce alarm status`)');
        }
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

  cmd
    .command('test-mode')
    .argument(
      '[estado]',
      "'on' prende el modo prueba, 'off' lo apaga; sin argumento sólo lo muestra",
    )
    .description('Modo prueba: el disparo llega sólo como push, sin sirena (CCE#122)')
    .action(async (estado?: string) => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });

      // Un estado que no se entiende NO se manda: adivinar acá es prender o
      // apagar el modo prueba de una alarma real por un typo. `exitCode` y no
      // `process.exit`, como el resto de los cortes tempranos del CLI.
      const pedido = estado?.toLowerCase();
      if (pedido !== undefined && pedido !== 'on' && pedido !== 'off') {
        fail(`Estado desconocido: "${estado}". Usá 'on' u 'off' (o nada para ver el estado).`);
        process.exitCode = 1;
        return;
      }

      try {
        if (pedido === undefined) {
          const { data } = await client.get('/config/alarm-test-mode');
          printObject(data, fmt === 'table' ? 'json' : fmt);
          if (esModoPrueba(data)) avisoModoPrueba();
          return;
        }

        const enabled = pedido === 'on';
        const spinner = ora(
          enabled ? 'Activando modo prueba...' : 'Desactivando modo prueba...',
        ).start();
        await client.put('/config/alarm-test-mode', { enabled });
        spinner.stop();
        if (enabled) {
          success('Modo prueba ACTIVADO');
          avisoModoPrueba();
        } else {
          success('Modo prueba desactivado — la alarma vuelve a sonar');
        }
      } catch (e) {
        fail((e as Error).message);
        process.exit(1);
      }
    });
}

/**
 * El modo prueba es un toggle MANUAL que no vence solo, así que la única
 * defensa contra olvidarlo prendido es que se vea (CCE#122). Va por STDERR:
 * `cce alarm status --format json | jq` sigue recibiendo JSON válido.
 */
function avisoModoPrueba(): void {
  warn('MODO PRUEBA ACTIVO: la alarma NO va a sonar (sin sirena, sin repetición).');
  warn('Se apaga a mano con `cce alarm test-mode off`.');
}

/**
 * Avisa a partir de la respuesta de `/config/alarm-armed`, que trae `testMode`
 * junto al `armed`. Una API vieja no lo manda: sin el campo no se inventa nada.
 */
function avisarModoPrueba(data: unknown): void {
  if (data && typeof data === 'object' && (data as { testMode?: unknown }).testMode === true) {
    avisoModoPrueba();
  }
}

/** Lo mismo sobre la respuesta de `/config/alarm-test-mode`, que usa `enabled`. */
function esModoPrueba(data: unknown): boolean {
  return (
    !!data && typeof data === 'object' && (data as { enabled?: unknown }).enabled === true
  );
}
