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
        avisarTipo(data);
        avisarModoPrueba(data);
      } catch (e) {
        fail((e as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('arm')
    .argument(
      '[tipo]',
      "'perimetral' o 'total'; sin argumento arma el tipo que esté elegido",
    )
    .description('Armar la alarma (PUT /config/alarm-armed { armed: true })')
    .action(async (tipo?: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });

      // Un tipo que no se entiende NO se manda. Adivinar acá es armar la
      // alarma de una casa real protegiendo otra cosa de la que se pidió —
      // exactamente el mismo criterio que `test-mode` con `on`/`off`.
      let modo: AlarmMode | undefined;
      if (tipo !== undefined) {
        modo = parseTipo(tipo);
        if (!modo) {
          fail(
            `Tipo desconocido: "${tipo}". Usá 'perimetral' o 'total' ` +
              '(o nada para armar el tipo elegido).',
          );
          process.exitCode = 1;
          return;
        }
      }

      const spinner = ora(
        modo ? `Armando alarma ${etiquetaTipo(modo)}...` : 'Armando alarma...',
      ).start();
      try {
        // SIN `mode` cuando no se pidió uno: el backend arma el tipo que esté
        // elegido. Es lo que hace que `cce alarm arm` siga significando lo
        // mismo que antes de CCE#133, igual que Siri y las escenas.
        const { data } = await client.put('/config/alarm-armed', {
          armed: true,
          ...(modo ? { mode: modo } : {}),
        });
        spinner.stop();
        // Lo que se dice es lo que confirmó el BACKEND, no lo que se pidió:
        // sin `mode` en la respuesta (una API vieja) se dice «Alarma armada»
        // a secas en vez de inventar un tipo.
        const confirmado = leerEstado(data).mode;
        success(confirmado ? `Alarma armada — ${etiquetaTipo(confirmado)}` : 'Alarma armada');

        // "Alarma armada" a secas mientras el disparo está degradado es la
        // trampa que el modo prueba puede tender (CCE#122): el estado se
        // relee para poder decirlo acá mismo.
        try {
          const { data: estado } = await client.get('/config/alarm-armed');
          if (!confirmado) avisarTipo(estado);
          avisarModoPrueba(estado);
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
    .command('mode')
    .argument(
      '[tipo]',
      "'perimetral' o 'total'; sin argumento sólo muestra el elegido",
    )
    .description('Tipo de alarma, sin armar ni desarmar (CCE#133)')
    .action(async (tipo?: string) => {
      const g = getGlobals(cmd);
      const fmt = resolveFormat(g.format);
      const client = createApiClient({ apiUrl: g.apiUrl });

      if (tipo === undefined) {
        try {
          const { data } = await client.get('/config/alarm-armed');
          const estado = leerEstado(data);
          if (!estado.mode) {
            fail('Esta API no conoce los tipos de alarma (actualizá el backend).');
            process.exitCode = 1;
            return;
          }
          printObject(
            { mode: estado.mode, armed: estado.armed },
            fmt === 'table' ? 'json' : fmt,
          );
          avisarTipo(data);
        } catch (e) {
          fail((e as Error).message);
          process.exitCode = 1;
        }
        return;
      }

      const modo = parseTipo(tipo);
      if (!modo) {
        fail(
          `Tipo desconocido: "${tipo}". Usá 'perimetral' o 'total' ` +
            '(o nada para ver el elegido).',
        );
        process.exitCode = 1;
        return;
      }

      const spinner = ora(`Cambiando a alarma ${etiquetaTipo(modo)}...`).start();
      try {
        const { data } = await client.put('/config/alarm-mode', { mode: modo });
        spinner.stop();

        // Una respuesta sin `mode` no confirma nada: decir «ahora es
        // perimetral» sin que el backend lo haya guardado es prometer que el
        // movimiento interior dejó de disparar cuando sigue disparando.
        const confirmado = leerEstado(data).mode;
        if (!confirmado) {
          fail('El backend no confirmó el tipo de alarma (respuesta sin `mode`).');
          process.exitCode = 1;
          return;
        }

        const armed = await leerArmed(client);
        success(`Tipo de alarma: ${etiquetaTipo(confirmado)}`);
        // Cambiar el tipo NO arma ni desarma, y eso hay que decirlo: con la
        // alarma armada cambió qué protege la casa AHORA; desarmada es sólo
        // lo que se va a armar la próxima vez.
        if (armed === true) {
          warn(`La alarma sigue ARMADA y ahora protege: ${queProtege(confirmado)}`);
        } else if (armed === false) {
          warn(`La alarma sigue desarmada; al armarla va a proteger: ${queProtege(confirmado)}`);
        }
      } catch (e) {
        spinner.stop();
        fail((e as Error).message);
        process.exitCode = 1;
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

/**
 * El TIPO de alarma (CCE#133): qué protege cuando está armada.
 *
 * La alarma era un booleano y por eso casi no se usaba: con los 20 sensores
 * marcados, armarla con gente adentro la hacía sonar en cuanto alguien cruzaba
 * el pasillo. `perimeter` protege puertas y accesos; `total`, todo.
 */
type AlarmMode = 'perimeter' | 'total';

/**
 * Lo que el usuario escribe → el literal del contrato. `undefined` si no se
 * entiende, y ahí NO se manda nada: adivinar es armar la casa protegiendo otra
 * cosa de la que se pidió.
 *
 * Se aceptan las dos formas —la castellana, que es la que uno escribe, y la
 * del contrato, que es la que aparece en el JSON de `status`—.
 */
function parseTipo(valor: string): AlarmMode | undefined {
  const v = valor.toLowerCase().trim();
  if (v === 'perimetral' || v === 'perimeter' || v === 'perimetro' || v === 'perímetro') {
    return 'perimeter';
  }
  if (v === 'total') return 'total';
  return undefined;
}

/** Cómo se nombra el tipo en un mensaje. */
function etiquetaTipo(mode: AlarmMode): string {
  return mode === 'perimeter' ? 'PERIMETRAL' : 'TOTAL';
}

/** Qué protege cada tipo, en una línea. «Perimetral» no dice nada por sí solo. */
function queProtege(mode: AlarmMode): string {
  return mode === 'perimeter'
    ? 'sólo puertas y accesos (se puede estar adentro)'
    : 'todo, incluido el movimiento adentro de casa';
}

/** Lee `{armed, mode, testMode}` de la respuesta de `/config/alarm-armed`. */
function leerEstado(data: unknown): {
  armed?: boolean;
  mode?: AlarmMode;
  testMode: boolean;
} {
  if (!data || typeof data !== 'object') return { testMode: false };
  const d = data as { armed?: unknown; mode?: unknown; testMode?: unknown };
  return {
    armed: typeof d.armed === 'boolean' ? d.armed : undefined,
    // Ausente = una API vieja que no conoce los tipos. NO se asume `total`:
    // inventar un tipo que nadie dijo es la forma de mentir sobre qué protege.
    mode: d.mode === 'perimeter' || d.mode === 'total' ? d.mode : undefined,
    testMode: d.testMode === true,
  };
}

/**
 * El TIPO, junto al estado (CCE#133). Va por STDERR como el aviso del modo
 * prueba: `cce alarm status --format json | jq` sigue recibiendo JSON válido.
 *
 * Sólo con la alarma ARMADA se dice qué protege AHORA; desarmada alcanza con
 * decir cuál se va a armar, sin gritar.
 */
function avisarTipo(data: unknown): void {
  const estado = leerEstado(data);
  if (!estado.mode) return;
  if (estado.armed === true) {
    warn(`Alarma ${etiquetaTipo(estado.mode)}: protege ${queProtege(estado.mode)}.`);
  } else {
    warn(`Tipo elegido: ${etiquetaTipo(estado.mode)} (al armarla protege ${queProtege(estado.mode)}).`);
  }
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
