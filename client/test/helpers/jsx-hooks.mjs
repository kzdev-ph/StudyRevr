import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transformWithOxc } from 'vite';

// A module-loader hook: .jsx files are compiled with the same transform Vite uses (automatic JSX runtime).
export async function load(url, context, nextLoad) {
  if (!url.endsWith('.jsx')) return nextLoad(url, context);
  const file = fileURLToPath(url);
  const out = await transformWithOxc(await readFile(file, 'utf8'), file, { lang: 'jsx', jsx: { runtime: 'automatic' } });
  return { format: 'module', source: out.code, shortCircuit: true };
}
