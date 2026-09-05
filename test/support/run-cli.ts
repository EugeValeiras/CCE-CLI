import { Command } from 'commander';

/**
 * Corre un comando del CLI como lo corre `bin/cce.ts`, capturando lo que
 * imprime y con qué código sale.
 *
 * `out` junta stdout y stderr a propósito: lo que se afirma es que el mensaje
 * LLEGÓ, no por cuál stream. (Que el reporte esté partido entre los dos es un
 * punto abierto del review, anotado en el PR.)
 */
export async function runCli(
  register: (program: Command) => void,
  argv: string[],
): Promise<{ out: string; exitCode: number }> {
  const lines: string[] = [];
  const capture =
    () =>
    (...args: unknown[]): void => {
      lines.push(args.map((a) => String(a)).join(' '));
    };
  const real = { log: console.log, error: console.error, warn: console.warn };
  console.log = capture();
  console.error = capture();
  console.warn = capture();
  const program = new Command();
  program.exitOverride();
  program.option('--api-url <url>').option('--format <format>', '', 'table');
  register(program);
  try {
    await program.parseAsync(argv, { from: 'user' });
  } finally {
    console.log = real.log;
    console.error = real.error;
    console.warn = real.warn;
  }
  return { out: lines.join('\n'), exitCode: Number(process.exitCode ?? 0) };
}

/** Alimenta stdin con `texto` mientras corre `fn` (para `config set-remote`). */
export async function withStdin<T>(texto: string, fn: () => Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, 'stdin');
  const chunks: Array<[string, (...a: never[]) => void]> = [];
  const fake = {
    isTTY: false,
    setEncoding() {},
    on(event: string, cb: (...a: never[]) => void) {
      chunks.push([event, cb]);
      // El comando registra data/end/error y después await-ea: alcanza con
      // emitirlos en el próximo tick.
      if (event === 'end') {
        setImmediate(() => {
          for (const [e, c] of chunks) {
            if (e === 'data') (c as (s: string) => void)(texto);
          }
          cb();
        });
      }
      return fake;
    },
  };
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  try {
    return await fn();
  } finally {
    if (real) Object.defineProperty(process, 'stdin', real);
  }
}
