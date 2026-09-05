import { Command } from 'commander';
import * as fs from 'fs';
import ora from 'ora';
import { createApiClient } from '../lib/api-client.js';
import {
  Column,
  fail,
  note,
  printObject,
  printRows,
  success,
  successNote,
  warn,
} from '../lib/format.js';
import { resolveFormat } from '../lib/user-config.js';
import { countSteps, describeTriggers, renderAutomation } from '../lib/flow-format.js';
import {
  AutomationInput,
  UpsertReport,
  deleteAutomation,
  retryIsSafe,
  setAutomationEnabled,
  upsertAutomations,
} from '../lib/automations-api.js';
import { unknownStateMessage, warnIfStateUnknown } from '../lib/state-warning.js';
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
    .description('Crear/actualizar automatización(es) desde archivo JSON (item por item)')
    .requiredOption('-f, --file <path>', 'Archivo JSON con una Automation o un array')
    .action(async (opts: { file: string }) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      let items: AutomationInput[];
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(opts.file, 'utf-8'));
        items = (Array.isArray(parsed) ? parsed : [parsed]) as AutomationInput[];
      } catch (e) {
        fail((e as Error).message);
        process.exitCode = 1;
        return;
      }
      // Sin try/catch alrededor: `upsertAutomations` no propaga: corta en el
      // primer error y lo devuelve dentro del reporte, junto con lo que ya
      // quedó escrito y lo que ni se intentó. Ver `UpsertReport`.
      const report = await upsertAutomations(client, items);
      printUpsertReport(report);
      // `process.exitCode` y no `process.exit(1)`: con stdout hacia un pipe
      // (`| tee`, CI) el exit inmediato trunca las escrituras pendientes, y lo
      // que se pierde es justo el reporte de qué quedó aplicado tras un abort.
      if (report.failed) process.exitCode = 1;
    });

  cmd
    .command('delete <id>')
    .description('Eliminar una automatización')
    .action(async (id: string) => {
      const g = getGlobals(cmd);
      const client = createApiClient({ apiUrl: g.apiUrl });
      try {
        // El 404 de la API es el chequeo de existencia: preguntarlo antes con
        // un GET sería una respuesta vieja para cuando llegue el DELETE.
        await deleteAutomation(client, id);
        success(`Eliminada: ${id}`);
      } catch (e) {
        fail((e as Error).message);
        warnIfStateUnknown(e, `el borrado de ${id}`);
        process.exitCode = 1;
      }
    });
}

/**
 * El resultado de `create`, separando creadas de actualizadas — el «Guardadas:
 * …» de antes no distinguía, y con un upsert la diferencia es justamente el
 * dato: decía lo mismo al dar de alta algo nuevo que al pisar una automatización
 * que ya existía.
 *
 * Si hubo un error, el reporte también dice dónde cortó, qué no se intentó, si
 * el estado quedó en duda y si reaplicar el archivo es seguro: item por item no
 * hay "todo o nada", así que dejar el corte implícito sería el fallo silencioso
 * que este cambio viene a evitar.
 */
function printUpsertReport(report: UpsertReport): void {
  const ids = (action: 'created' | 'updated'): string[] =>
    report.applied.filter((o) => o.action === action).map((o) => o.id);
  const created = ids('created');
  const updated = ids('updated');
  // Todo el reporte por stderr: ver `successNote`.
  if (created.length) successNote(`Creadas (${created.length}): ${created.join(', ')}`);
  if (updated.length) successNote(`Actualizadas (${updated.length}): ${updated.join(', ')}`);

  // Los items que el archivo mandó SIN id: el que los escribió no tiene cómo
  // saber qué id les tocó, y son los únicos que reaplicar duplicaría.
  const generated = report.applied.filter((o) => o.idGeneratedByServer);
  if (generated.length) {
    warn(
      `Con id generado por la API (${generated.length}) — el archivo no los trae, así que ` +
        'reaplicarlo tal cual las DUPLICA:',
    );
    for (const o of generated) console.error(`    ${o.label} → ${o.id}`);
  }

  for (const w of report.warnings) warn(w);

  if (!report.failed) {
    if (!report.applied.length) note('El archivo no traía ninguna automatización.');
    return;
  }
  fail(`Falló en ${report.failed.label}: ${report.failed.message}`);
  if (report.failed.stateUnknown) warn(unknownStateMessage(report.failed.label));
  if (report.notAttempted.length) {
    warn(`Sin intentar (${report.notAttempted.length}): ${report.notAttempted.join(', ')}`);
  }
  note(retryAdvice(report));
}

/**
 * Qué hacer después de un abort.
 *
 * La pregunta que contesta es una sola: ¿reaplicar el archivo puede DUPLICAR
 * algo? Duplican los items que entraron sin id (la API les acuñó uno que el
 * archivo no tiene) y, si el corte dejó el estado en duda, también el item que
 * cortó. El consejo los nombra a TODOS: acotar el riesgo a uno solo mientras
 * el stderr enumera otros manda a re-POSTear justo lo que no hay que tocar.
 */
function retryAdvice(report: UpsertReport): string {
  const abort = report.applied.length
    ? 'Se abortó en el primer error; lo listado arriba YA quedó escrito.'
    : 'Se abortó en el primer item.';
  if (retryIsSafe(report)) {
    // «No quedó nada escrito» sólo se puede afirmar si el servidor contestó.
    const nada = !report.applied.length && !report.failed?.stateUnknown
      ? ' No quedó nada escrito.'
      : '';
    return (
      `${abort}${nada} Corregí el archivo y reintentá: todo lo que se aplicó tiene id, ` +
      'así que volver a aplicarlo entero lo ACTUALIZA en vez de duplicarlo.'
    );
  }
  const enRiesgo = report.applied.filter((o) => o.idGeneratedByServer).map((o) => o.id);
  const partes: string[] = [];
  if (enRiesgo.length) {
    partes.push(`las que la API numeró (${enRiesgo.join(', ')})`);
  }
  if (report.failed?.stateUnknown && !report.failed.hadId) {
    partes.push(`el item que cortó (${report.failed.label}), que no se sabe si entró`);
  }
  return (
    `${abort} NO reapliques el archivo tal cual: ${partes.join(' y ')} se crearían de ` +
    'nuevo con OTRO id (automatizaciones duplicadas sobre el mismo trigger). Mirá ' +
    '`cce automations list`, sacá del archivo lo que ya esté —o poneles el id que les ' +
    'tocó— y recién ahí reintentá.'
  );
}

async function setEnabled(cmd: Command, id: string, enabled: boolean): Promise<void> {
  const g = getGlobals(cmd);
  const client = createApiClient({ apiUrl: g.apiUrl });
  const spinner = ora(`${enabled ? 'Habilitando' : 'Deshabilitando'} ${id}...`).start();
  try {
    // Un booleano de UNA automatización: antes esto traía las 22 y devolvía
    // las 22, con todo lo que hubiera cambiado en el medio pisado de vuelta.
    await setAutomationEnabled(client, id, enabled);
    spinner.stop();
    success(`${id} ${enabled ? 'habilitada' : 'deshabilitada'}`);
  } catch (e) {
    spinner.stop();
    fail((e as Error).message);
    warnIfStateUnknown(e, `el cambio sobre ${id}`);
    process.exitCode = 1;
  }
}


