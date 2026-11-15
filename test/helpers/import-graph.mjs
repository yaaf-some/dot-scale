// Static import graph of the app (no build step, so a regex over `import`/`export … from` is enough).
// Dynamic import() is deliberately not followed: it marks a lazy boundary.
import { readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

const STATIC = /(?:^|[\n;])\s*(?:import|export)\s+(?:[^'"();]*?\s+from\s+)?['"]([^'"]+)['"]/g;

export function staticImports(file) {
  const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const out = [];
  for (const m of src.matchAll(STATIC)) if (m[1].startsWith('.')) out.push(resolve(dirname(file), m[1]));
  return out;
}

/** Every file reachable from `entry` through static imports → { files: Map(path → depth), depth }. */
export function importGraph(entry) {
  const depth = new Map([[entry, 0]]);
  let level = [entry];
  while (level.length) {
    const next = [];
    for (const f of level) for (const dep of staticImports(f)) {
      if (!depth.has(dep)) { depth.set(dep, depth.get(f) + 1); next.push(dep); }
    }
    level = next;
  }
  return { files: depth, depth: Math.max(...depth.values()) };
}

export const rel = (root, f) => relative(root, f).split('\\').join('/');

/** The modules index.html must preload: everything app/main.js loads statically, plus the first screen (Home). */
export function criticalModules(root) {
  const set = new Map();
  for (const entry of ['app/main.js', 'app/ui/views/home.js']) {
    for (const [f, d] of importGraph(resolve(root, entry)).files) set.set(f, Math.min(d, set.get(f) ?? Infinity));
  }
  return [...set.entries()].sort((a, b) => a[1] - b[1] || (rel(root, a[0]) < rel(root, b[0]) ? -1 : 1)).map(([f]) => rel(root, f));
}
