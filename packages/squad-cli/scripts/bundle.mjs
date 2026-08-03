import { build } from 'esbuild';

await build({
  entryPoints: ['dist/cli-entry.js'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/squad.js',
  // The Agent SDK must stay external: it resolves a native per-platform
  // binary relative to its own file on disk, which inlining breaks — and it
  // breaks at runtime, in the shipped bundle only, where no test would catch
  // it. zod and the MCP SDK follow it out as its peers.
  external: [
    'node-pty',
    'sql.js',
    '@opentelemetry/sdk-node',
    'ws',
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/sdk',
    '@modelcontextprotocol/sdk',
    'zod',
  ],
  banner: {
    js: [
      // esbuild preserves the entry file's own shebang (from cli-entry.ts) as
      // the first output line — do not add a second one here, or Node's ESM
      // loader chokes on the duplicate `#!` as invalid syntax.
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
