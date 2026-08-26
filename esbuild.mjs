import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Reports build errors with file:line so they are clickable in the terminal. */
const problemReporter = {
  name: 'problem-reporter',
  setup(build) {
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) console.error(`    ${location.file}:${location.line}:${location.column}`);
      }
      const label = build.initialOptions.outfile;
      if (result.errors.length === 0) console.log(`✔ built ${label}`);
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'silent',
  plugins: [problemReporter],
};

const targets = [
  {
    ...shared,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    // Provided by the VS Code runtime, never bundled.
    external: ['vscode'],
  },
  {
    ...shared,
    entryPoints: ['src/server/server.ts'],
    outfile: 'dist/server.js',
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['vscode'],
  },
  {
    ...shared,
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview.js',
    // IIFE + browser: the webview has no module loader and no Node globals.
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
  },
  {
    ...shared,
    entryPoints: ['webview/styles.css'],
    outfile: 'dist/webview.css',
    loader: { '.css': 'css' },
  },
];

if (watch) {
  const contexts = await Promise.all(targets.map((t) => esbuild.context(t)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching…');
} else {
  await Promise.all(targets.map((t) => esbuild.build(t)));
}
