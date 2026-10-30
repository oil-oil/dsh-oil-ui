import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeProAdapter(
  directory: string,
  rules: readonly Record<string, unknown>[] = [],
  transformVersion = '9',
) {
  const adapterDirectory = join(directory, 'adapters', 'dsh');
  await mkdir(adapterDirectory, { recursive: true });
  await writeFile(
    join(adapterDirectory, 'adapter.json'),
    JSON.stringify({ protocolVersion: 1, transformVersion, rules: './rules.json' }),
  );
  await writeFile(join(adapterDirectory, 'rules.json'), JSON.stringify(rules));
}
