/**
 * vite.config.js — 로컬 SDK 테스트 번들 설정
 *
 * 역할: test-sdk.js를 브라우저에서 바로 붙일 수 있는 IIFE 번들로 만든다.
 *      운영 번들은 backend/build.js의 esbuild 설정을 사용한다.
 */

import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: './test-sdk.js',
      name: 'GhostTracker',
      fileName: 'ghosttracker',
      formats: ['iife']
    },
    rollupOptions: {
      treeshake: false
    }
  }
});
