// Builds the npm package: `dist/mod.js` (a single ESM bundle of every module `mod.ts` re-exports,
// via esbuild — which resolves the `./x.ts` import specifiers the source uses natively), the
// matching `.d.ts` files (via `tsc`, whose `rewriteRelativeImportExtensions` turns those same
// `./x.ts` specifiers into `./x.js` in the emitted declarations), and a copy of `default/` beside
// the bundle — `default_config.ts` resolves it as `new URL('./default/', import.meta.url)`, which
// only works once the two sit next to each other in `dist/`.
import { build } from 'esbuild';
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const outdir = 'dist';

await rm(outdir, { recursive: true, force: true });

await build({
  entryPoints: ['mod.ts'],
  outfile: `${outdir}/mod.js`,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  // Both are real npm dependencies (see package.json) — left external so the published
  // package resolves them from the consumer's own node_modules rather than vendoring a
  // second copy, and so `devcontainer.ts`'s `import.meta.resolve('@devcontainers/cli/...')`
  // still finds a real package on disk to resolve.
  external: ['@devcontainers/cli', 'jsonc-parser'],
});

execFileSync('npx', ['tsc', '--project', 'tsconfig.json'], {
  stdio: 'inherit',
});

// `rewriteRelativeImportExtensions` (tsconfig.json) only rewrites `./x.ts` → `./x.js` in emitted
// *JavaScript* — `tsc`'s own `.d.ts` emission leaves the source `.ts` extension untouched (as of
// TS 5.9), which a `.ts`-less npm consumer cannot resolve. Fix up the declarations by hand: every
// specifier here is a plain `./name.ts`, so a straight extension swap is exact, not a heuristic.
for (const name of await readdir(outdir)) {
  if (!name.endsWith('.d.ts')) continue;
  const path = `${outdir}/${name}`;
  const text = await readFile(path, 'utf8');
  const fixed = text.replace(/(from\s+['"]\.[^'"]*)\.ts(['"])/g, '$1.js$2');
  if (fixed !== text) await writeFile(path, fixed);
}

await cp('default', `${outdir}/default`, { recursive: true });

console.log(`built ${outdir}/`);
