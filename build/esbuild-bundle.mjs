import { build } from 'esbuild';
import { join } from 'path';

const entry = join(process.cwd(), 'src', 'extension.ts');

(async () => {
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outdir: 'dist',
    sourcemap: true,
    external: [
      'vscode', // VS Code API 必须 external
      'puppeteer' // 让 puppeteer 仍通过依赖安装，不被打进 bundle
    ],
    logLevel: 'info',
    charset: 'utf8',
    minify: false
  });
  console.log('Bundle complete');
})();
