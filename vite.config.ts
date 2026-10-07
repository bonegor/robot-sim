import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // The physics engine ships its WebAssembly inline (~3 MB), in its own lazily loaded chunk.
    chunkSizeWarningLimit: 5000,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
