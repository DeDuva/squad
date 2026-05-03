import { build } from 'esbuild';

await build({
  entryPoints: ['dist/cli-entry.js'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/squad.js',
  external: ['node-pty', 'sql.js', '@opentelemetry/sdk-node', 'ws'],
  banner: { js: '#!/usr/bin/env node' },
  minify: false,
  plugins: [
    {
      name: 'stub-react-devtools-core',
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: 'react-devtools-core',
          namespace: 'stub',
        }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export default null;',
          loader: 'js',
        }));
      },
    },
  ],
}).catch(() => process.exit(1));
