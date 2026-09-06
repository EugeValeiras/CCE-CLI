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

      if (pedido === undefined) {
        try {
          // `/config/alarm-armed` y no `/config/alarm-test-mode`: trae el
          // `armed` en el mismo payload, y sin él el aviso no puede saber si
          // la alarma iba a sonar.
          const { data } = await client.get('/config/alarm-armed');
          const estadoActual = leerEstado(data);
          printObject(
            { enabled: estadoActual.testMode, armed: estadoActual.armed },
            fmt === 'table' ? 'json' : fmt,
          );
          if (estadoActual.testMode) avisoModoPrueba(estadoActual.armed);
        } catch (e) {
          fail((e as Error).message);
          process.exitCode = 1;
        }
        return;
      }

      const enabled = pedido === 'on';
      // El spinner se declara ANTES del try: creado adentro, el `catch` no
      // puede pararlo y el error se escribe dentro de la línea del spinner.
      const spinner = ora(
        enabled ? 'Activando modo prueba...' : 'Desactivando modo prueba...',
      ).start();
      try {
        const { data } = await client.put('/config/alarm-test-mode', { enabled });
        spinner.stop();

        // Lo que quedó es lo que dice el BACKEND, no lo que se pidió. Una
        // respuesta sin `enabled` no confirma nada: decir "la alarma vuelve a
        // sonar" sin que el backend lo haya guardado es el peor misreporte
        // posible acá.
        const confirmado = (data as { enabled?: unknown } | undefined)?.enabled;
        if (typeof confirmado !== 'boolean') {
          fail('El backend no confirmó el modo prueba (respuesta sin `enabled`).');
          process.exitCode = 1;
          return;
        }

        const armed = await leerArmed(client);
        if (confirmado) {
          success('Modo prueba ACTIVADO');
          avisoModoPrueba(armed);
        } else {
          success(
            armed === false
              ? 'Modo prueba desactivado'
              : 'Modo prueba desactivado — la alarma vuelve a sonar',
          );
        }
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exitCode = 1;
      }
    });
}

/**
 * El modo prueba es un toggle MANUAL que no vence solo, así que la única
 * defensa contra olvidarlo prendido es que se vea (CCE#122). Va por STDERR:
 * `cce alarm status --format json | jq` sigue recibiendo JSON válido.
 *
 * Con la alarma DESARMADA el aviso baja el tono: gritar "no va a sonar" sobre
 * una alarma que no iba a sonar igual convierte en rutina un mensaje cuyo
 * valor entero es ser raro.
 */
function avisoModoPrueba(armed?: boolean): void {
  if (armed === false) {
    warn('Modo prueba activo (la alarma está desarmada).');
    return;
  }
  warn('MODO PRUEBA ACTIVO: la alarma NO va a sonar (sin sirena, sin repetición).');
  warn('Se apaga a mano con `cce alarm test-mode off`.');
}

/** Lee `{armed, testMode}` de la respuesta de `/config/alarm-armed`. */
function leerEstado(data: unknown): { armed?: boolean; testMode: boolean } {
  if (!data || typeof data !== 'object') return { testMode: false };
  const d = data as { armed?: unknown; testMode?: unknown };
  return {
    armed: typeof d.armed === 'boolean' ? d.armed : undefined,
    testMode: d.testMode === true,
  };
}

/**
 * Avisa a partir de la respuesta de `/config/alarm-armed`, que trae `testMode`
 * junto al `armed`. Una API vieja no lo manda: sin el campo no se inventa nada.
 */
function avisarModoPrueba(data: unknown): void {
  const estado = leerEstado(data);
  if (estado.testMode) avisoModoPrueba(estado.armed);
}

/**
 * El `armed` de ahora, para poder matizar el mensaje. Best-effort: si no se
 * puede leer, el aviso sale en su forma completa — errar hacia el aviso fuerte
 * es el lado seguro.
 */
async function leerArmed(client: {
  get: (path: string) => Promise<{ data: unknown }>;
}): Promise<boolean | undefined> {
  try {
    const { data } = await client.get('/config/alarm-armed');
    return leerEstado(data).armed;
  } catch {
    return undefined;
  }
}
