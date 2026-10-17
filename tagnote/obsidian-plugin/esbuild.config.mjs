// 照官方 obsidian-sample-plugin 的打包配置：main.ts（含 vendor/tagnote.esm.js 引擎）→ main.js
// npm run dev：监听改动、带 sourcemap；npm run build：类型检查 + 压缩打包。
import esbuild from 'esbuild';
import process from 'node:process';
import { builtinModules } from 'node:module';

const prod = process.argv[2] === 'production';

const context = await esbuild.context({
  banner: { js: '/* TagNote Obsidian 插件。由 esbuild 从 main.ts 打包生成，不要手改；源码见 tagnote/obsidian-plugin/。 */' },
  entryPoints: ['main.ts'],
  bundle: true,
  external: [
    'obsidian', 'electron',
    '@codemirror/autocomplete', '@codemirror/collab', '@codemirror/commands', '@codemirror/language',
    '@codemirror/lint', '@codemirror/search', '@codemirror/state', '@codemirror/view',
    '@lezer/common', '@lezer/highlight', '@lezer/lr',
    ...builtinModules,
  ],
  format: 'cjs',
  target: 'es2020',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: prod,
  charset: 'utf8',
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
