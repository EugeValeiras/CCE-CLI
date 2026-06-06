#!/usr/bin/env node
import { Command } from 'commander';
import { registerDevicesCommand } from '../commands/devices.js';
import { registerScanCommand } from '../commands/scan.js';
import { registerAutomationsCommand } from '../commands/automations.js';
import { registerConfigCommand } from '../commands/config.js';
import { registerEventsCommand } from '../commands/events.js';
import { registerHueCommand } from '../commands/hue.js';
import { registerAlarmCommand } from '../commands/alarm.js';
import { registerScenesCommand } from '../commands/scenes.js';
import { registerGroupsCommand } from '../commands/groups.js';
import { registerNotifyCommand } from '../commands/notify.js';

const program = new Command();

program
  .name('cce')
  .description('CLI para CCE — Control de Casa (devices, scan, hue, automations, config, events)')
  .version('0.1.0')
  .option('--api-url <url>', 'URL de la API CCE (default: http://localhost:3000 o $CCE_API_URL)')
  .option('--format <format>', 'Formato de salida: table | json | csv', 'table');

registerDevicesCommand(program);
registerScanCommand(program);
registerHueCommand(program);
registerAlarmCommand(program);
registerScenesCommand(program);
registerGroupsCommand(program);
registerNotifyCommand(program);
registerAutomationsCommand(program);
registerConfigCommand(program);
registerEventsCommand(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
