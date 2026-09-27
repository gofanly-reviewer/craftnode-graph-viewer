import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist');
const pages = path.join(root, 'docs');

if (!existsSync(path.join(output, 'index.html'))) {
  throw new Error('Build output is missing. Run npm run build before syncing GitHub Pages.');
}

rmSync(pages, { recursive: true, force: true });
mkdirSync(pages, { recursive: true });
cpSync(output, pages, { recursive: true });
writeFileSync(path.join(pages, '.nojekyll'), '');
