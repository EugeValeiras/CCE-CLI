import Table from 'cli-table3';
import chalk from 'chalk';

export type OutputFormat = 'table' | 'json' | 'csv';

export interface Column<T> {
  header: string;
  get: (row: T) => string | number | boolean | null | undefined;
}

export function printRows<T>(rows: T[], columns: Column<T>[], fmt: OutputFormat): void {
  if (fmt === 'json') {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (fmt === 'csv') {
    const header = columns.map((c) => csvEscape(c.header)).join(',');
    console.log(header);
    for (const row of rows) {
      console.log(columns.map((c) => csvEscape(String(c.get(row) ?? ''))).join(','));
    }
    return;
  }
  const table = new Table({
    head: columns.map((c) => chalk.bold.cyan(c.header)),
    style: { head: [], border: ['gray'] },
  });
  for (const row of rows) {
    table.push(columns.map((c) => formatCell(c.get(row))));
  }
  console.log(table.toString());
}

export function printObject(obj: unknown, fmt: OutputFormat): void {
  if (fmt === 'json' || fmt === 'csv') {
    console.log(JSON.stringify(obj, null, 2));
    return;
  }
  if (obj && typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>);
    const table = new Table({
      head: [chalk.bold.cyan('Key'), chalk.bold.cyan('Value')],
      style: { head: [], border: ['gray'] },
    });
    for (const [k, v] of entries) {
      table.push([k, typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')]);
    }
    console.log(table.toString());
  } else {
    console.log(obj);
  }
}

export function success(msg: string): void {
  console.log(chalk.green('✓'), msg);
}

export function info(msg: string): void {
  console.log(chalk.blue('ℹ'), msg);
}

export function warn(msg: string): void {
  console.warn(chalk.yellow('!'), msg);
}

export function fail(msg: string): void {
  console.error(chalk.red('✗'), msg);
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined || value === '') return chalk.gray('-');
  if (typeof value === 'boolean') return value ? chalk.green('yes') : chalk.gray('no');
  return String(value);
}

function csvEscape(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
