import chalk from 'chalk';
import { Automation, FlowAction, FlowCond, FlowStep } from '../types/api.js';

/**
 * CCE#64 — El flujo de una automatización, indentado y legible.
 *
 * Un árbol de steps volcado como JSON crudo es ilegible en una terminal: con
 * dos `if` anidados y un `waitFor` con su `onTimeout`, lo que uno quiere saber
 * —qué pasa primero, qué decide cada rama, cuánto espera— queda enterrado entre
 * llaves. Acá cada step es una línea, la anidación es sangría, y la condición
 * se escribe como se lee («si hay movimiento Y está oscuro»).
 */

/** Resumen de una acción en una línea: el kind y su target. */
export function describeAction(a: FlowAction): string {
  const g = (k: string): string => {
    const v = a[k];
    return v === undefined || v === null ? '' : String(v);
  };
  switch (a.kind) {
    case 'device': {
      const on = a.on;
      const verb =
        on === true ? 'prender' : on === false ? 'apagar' : on === 'toggle' ? 'alternar' : String(on);
      const bits = ['bri', 'hue', 'sat', 'ct', 'briDelta']
        .filter((k) => a[k] !== undefined)
        .map((k) => `${k}=${String(a[k])}`);
      return `${verb} ${g('deviceId')}${bits.length ? ` (${bits.join(', ')})` : ''}`;
    }
    case 'deviceVerb':
      return `${g('verb')}(${a.args ? JSON.stringify(a.args) : ''}) sobre ${g('deviceId')}`;
    case 'group':
      return `grupo ${g('groupId')} → ${a.action ?? 'on'}`;
    case 'hueRoom':
      return `room Hue ${g('hueRoomId')} → ${a.action ?? 'on'}`;
    case 'scene':
      return `escena ${g('sceneId')}`;
    case 'hueScene':
      return `escena Hue ${g('hueSceneId')}${a.smart ? ' (smart)' : ''}`;
    case 'notification':
      return `avisar${a.message ? `: "${g('message')}"` : ''}`;
    case 'announce':
      return `anunciar ${g('announcerId')}`;
    case 'automation': {
      const ids = Array.isArray(a.automationIds) ? a.automationIds : [];
      return `${a.action ?? 'toggle'} ${ids.length} automatización(es): ${ids.join(', ')}`;
    }
    case 'jbl': {
      const bits: string[] = [String(a.action ?? 'on')];
      if (a.onMode) bits.push(String(a.onMode));
      if (a.radioName) bits.push(`radio "${g('radioName')}"`);
      if (a.volume !== undefined) bits.push(`vol ${g('volume')}`);
      if (a.nightMode) bits.push('modo noche');
      return `JBL ${bits.join(', ')}`;
    }
    case 'alarm':
      return `alarma → ${a.action ?? 'toggle'}`;
    case 'call':
      return `llamar ${a.contactId ? `contacto ${g('contactId')}` : g('number')}${
        a.ringSeconds !== undefined ? ` (${g('ringSeconds')}s)` : ''
      }`;
    default:
      return `${String(a.kind)} ${JSON.stringify(a)}`;
  }
}

/** Una condición como frase. Los and/or se anidan entre paréntesis. */
export function describeCond(c: FlowCond): string {
  const rec = c as Record<string, unknown>;
  if (Array.isArray(rec.and)) {
    return (rec.and as FlowCond[]).map(describeCond).join(' Y ');
  }
  if (Array.isArray(rec.or)) {
    return `(${(rec.or as FlowCond[]).map(describeCond).join(' O ')})`;
  }
  if (rec.not && typeof rec.not === 'object') {
    return `NO (${describeCond(rec.not as FlowCond)})`;
  }
  const type = (rec.type as string) ?? 'sensor';
  const op = rec.operator ? ` ${String(rec.operator)} ` : ' = ';
  switch (type) {
    case 'timeWindow':
      return `entre ${String(rec.fromTime)} y ${String(rec.toTime)}`;
    case 'modulePower':
      return `${String(rec.module)} ${rec.on ? 'encendido' : 'apagado'}`;
    case 'deviceState':
      return `${String(rec.deviceId)}.${String(rec.field)}${op}${JSON.stringify(rec.value)}`;
    default:
      return `${String(rec.sensorId)}.${String(rec.field)}${op}${JSON.stringify(rec.value)}`;
  }
}

/** El árbol de steps como líneas indentadas. */
export function renderFlow(flow: FlowStep[], indent = 0): string[] {
  const pad = '  '.repeat(indent);
  const out: string[] = [];
  for (const step of flow) {
    switch (step.type) {
      case 'do':
        out.push(`${pad}${chalk.cyan('hacer')}`);
        for (const a of step.actions) out.push(`${pad}  • ${describeAction(a)}`);
        break;
      case 'if':
        out.push(`${pad}${chalk.yellow('si')} ${describeCond(step.cond)}`);
        out.push(...renderFlow(step.then, indent + 1));
        if (step.else?.length) {
          out.push(`${pad}${chalk.yellow('si no')}`);
          out.push(...renderFlow(step.else, indent + 1));
        }
        break;
      case 'wait':
        out.push(`${pad}${chalk.magenta('esperar')} ${step.seconds}s`);
        break;
      case 'waitFor':
        out.push(
          `${pad}${chalk.magenta('esperar a que')} ${describeCond(step.cond)} ` +
            chalk.gray(`(timeout ${step.timeoutSeconds}s)`),
        );
        if (step.onTimeout?.length) {
          out.push(`${pad}${chalk.magenta('si vence')}`);
          out.push(...renderFlow(step.onTimeout, indent + 1));
        }
        break;
      case 'stop':
        out.push(`${pad}${chalk.red('terminar')}`);
        break;
    }
  }
  return out;
}

/** Cuántos steps tiene un flujo, contando los de las ramas y las esperas. */
export function countSteps(flow: FlowStep[] | undefined): number {
  if (!flow) return 0;
  let n = 0;
  for (const step of flow) {
    n++;
    if (step.type === 'if') n += countSteps(step.then) + countSteps(step.else);
    else if (step.type === 'waitFor') n += countSteps(step.onTimeout);
  }
  return n;
}

/** Los triggers de una automatización, en una celda de tabla. */
export function describeTriggers(a: Automation): string {
  // read-both: `when` es el modelo nuevo; `trigger` sigue viniendo y es el
  // respaldo para una respuesta de un backend viejo.
  const triggers = a.when?.length ? a.when : a.trigger ? [a.trigger] : [];
  return triggers
    .map((t) => {
      if (t.type !== 'sensor') return t.type;
      const entries = Array.isArray(t.sensorTriggers) ? t.sensorTriggers : [];
      return entries.length > 1 ? `sensor ×${entries.length}` : 'sensor';
    })
    .join(', ');
}

/** El detalle de una automatización, con el flujo indentado. */
export function renderAutomation(a: Automation): string {
  const lines: string[] = [
    `${a.icon ? `${a.icon} ` : ''}${chalk.bold(a.name)} ${chalk.gray(`(${a.id})`)}`,
    `${chalk.bold('Estado:')}   ${a.enabled ? chalk.green('habilitada') : chalk.gray('pausada')}`,
    `${chalk.bold('Disparo:')}  ${describeTriggers(a)}`,
  ];
  if (a.onRetrigger) lines.push(`${chalk.bold('Re-disparo:')} ${a.onRetrigger}`);
  if (a.planId) lines.push(`${chalk.bold('Plano:')}    ${a.planId}`);

  lines.push('');
  const flow = a.flow ?? [];
  if (flow.length === 0) {
    lines.push(chalk.gray('(sin flujo)'));
  } else {
    lines.push(
      chalk.bold('Flujo:') +
        (a.flowDerived
          ? chalk.gray('  (derivado del formato viejo; se recalcula en cada lectura)')
          : ''),
    );
    lines.push(...renderFlow(flow, 1));
  }

  const condiciones = (a.trigger?.conditions ?? []) as unknown[];
  if (condiciones.length && a.flowDerived) {
    lines.push('');
    lines.push(
      chalk.gray('Las condiciones del disparo son el `si` de arriba: viven en trigger.conditions.'),
    );
  }
  return lines.join('\n');
}
