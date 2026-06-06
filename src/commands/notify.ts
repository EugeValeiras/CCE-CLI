import { Command } from 'commander';
import ora from 'ora';
import { createApiClient } from '../lib/api-client.js';
import { fail, success, OutputFormat } from '../lib/format.js';

interface GlobalOpts {
  apiUrl?: string;
  format?: OutputFormat;
}

function getGlobals(cmd: Command): GlobalOpts {
  const opts = cmd.optsWithGlobals<GlobalOpts>();
  return { apiUrl: opts.apiUrl, format: opts.format };
}

export function registerNotifyCommand(program: Command): void {
  const cmd = program
    .command('notify')
    .description('Enviar una notificación push (POST /push/send)')
    .option('--title <t>', 'Título de la notificación')
    .option('--body <b>', 'Cuerpo de la notificación')
    .option('--sound <sound>', 'Sonido: alarm | doorbell | alert')
    .option('--critical', 'Marcar como crítica')
    .action(
      async (opts: { title?: string; body?: string; sound?: string; critical?: boolean }) => {
        const g = getGlobals(cmd);
        const client = createApiClient({ apiUrl: g.apiUrl });
        if (!opts.title || !opts.body) {
          fail('Debe pasar --title y --body.');
          process.exit(1);
        }
        const body: Record<string, unknown> = { title: opts.title, body: opts.body };
        if (opts.sound) body.sound = opts.sound;
        if (opts.critical) body.critical = true;
        const spinner = ora('Enviando notificación...').start();
        try {
          await client.post('/push/send', body);
          spinner.stop();
          success('Notificación enviada');
        } catch (e) {
          spinner.stop();
          fail((e as Error).message);
          process.exit(1);
        }
      },
    );
}
