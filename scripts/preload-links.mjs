// Prints the <link rel="modulepreload"> lines index.html needs (test/preload.test.mjs checks they match the import graph).
import { fileURLToPath } from 'node:url';
import { criticalModules } from '../test/helpers/import-graph.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const f of criticalModules(root)) console.log(`<link rel="modulepreload" href="${f}">`);
