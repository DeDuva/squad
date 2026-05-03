import { build } from 'esbuild';

await build({
  entryPoints: ['dist/cli-entry.js'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/squad.js',
  external: ['node-pty', 'sql.js', '@opentelemetry/sdk-node', 'ws'],
  banner: {
    js: [
      '#!/usr/bin/env node',
      // CJS interop: give bundled packages a real require() so they can load
      // Node built-ins (assert, events, fs, …) without hitting esbuild's stub
      // that throws "Dynamic require of X is not supported".
      "import { createRequire as __cjsRequire } from 'module';",
      'const require = __cjsRequire(import.meta.url);',
    ].join('\n'),
  },
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
