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