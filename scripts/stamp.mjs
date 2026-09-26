// デプロイ直前に更新日時を version.mjs へ書き込む。コミットはしない。
import { readFile, writeFile } from 'node:fs/promises';
const url = new URL('../public/version.mjs', import.meta.url);
const source = await readFile(url, 'utf8');
await writeFile(url, source.replace(/export const BUILT = '[^']*';/, `export const BUILT = '${new Date().toISOString()}';`));
console.log('stamped', new Date().toISOString());
