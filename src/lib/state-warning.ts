import { isUnknownState } from './api-client.js';
import { warn } from './format.js';

/**
 * CCE#107 — El aviso de que la casa pudo haber cambiado igual.
 *
 * Hay errores en los que el CLI NO puede afirmar que la escritura no ocurrió:
 * la respuesta se perdió después de que el pedido salió, o el 5xx llegó
 * después del commit. Decir sólo «falló» ahí invita a reintentar sobre un
 * estado que ya cambió — y para un alta sin id, ese reintento es un duplicado.
 *
 * Vive suelto porque lo usan los dos comandos que escriben (`automations` y el
 * replace masivo de `config`), y el que faltaba era justamente el segundo.
 */
export function unknownStateMessage(que: string): string {
  return (
    `Estado DESCONOCIDO: no hubo una respuesta que lo confirme, así que ${que} pudo ` +
    'haberse aplicado igual. Verificá con `cce automations list` antes de reintentar.'
  );
}

/** Para los `catch`: avisa si este error dejó el estado en duda. */
export function warnIfStateUnknown(e: unknown, que: string): boolean {
  if (!isUnknownState(e)) return false;
  warn(unknownStateMessage(que));
  return true;
}
