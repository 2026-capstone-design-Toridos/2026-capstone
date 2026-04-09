/**
 * build.js — SDK 번들러
 * 실행: node build.js
 * 출력: public/gt.js  (브라우저 IIFE 단일 파일)
 */

const esbuild = require('esbuild');
const path    = require('path');

esbuild.build({
  entryPoints: [path.resolve(__dirname, '../index.js')],
  bundle:      true,
  format:      'iife',
  platform:    'browser',
  outfile:     path.resolve(__dirname, 'public/gt.js'),
  minify:      true,
  sourcemap:   false,
}).then(() => {
  console.log('[GhostTracker] SDK 번들 완료 → public/gt.js');
}).catch((e) => {
  console.error('[GhostTracker] 번들 실패:', e.message);
  process.exit(1);
});
