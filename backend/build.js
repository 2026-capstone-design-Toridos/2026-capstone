/**
 * GhostTracker SDK 빌드 스크립트
 * -----------------------------
 * esbuild를 사용해 브라우저용 단일 IIFE 파일로 번들링한다.
 *
 * 입력: index.js (SDK entry point)
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
