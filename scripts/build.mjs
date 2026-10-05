import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
await build({ entryPoints: ['src/index.ts', 'src/client.tsx', 'src/engine.ts'],
  outdir: 'dist', bundle: true, format: 'esm', platform: 'browser',
  target: 'es2022', packages: 'external', jsx: 'automatic', sourcemap: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--emitDeclarationOnly'], { stdio: 'inherit' });
