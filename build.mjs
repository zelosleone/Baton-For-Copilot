import { build } from 'esbuild';

// One ESM file: the Agent SDK, its MCP server and zod are bundled; Claude Code itself is not.
// `node build.mjs upstream` builds the daily upstream check instead.
const upstream = process.argv[2] === 'upstream';
await build({
  entryPoints: [upstream ? 'src/upstream.ts' : 'src/extension.ts'],
  outfile: upstream ? 'out/upstream.mjs' : 'out/extension.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['vscode'],
  // Bundled CommonJS code still calls require() for Node built-ins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
});
