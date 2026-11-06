import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Los tests "live" llaman a Claude de verdad y solo se ejecutan con `pnpm test:live`.
    exclude: ['test/**/*.live.test.ts', 'node_modules/**'],
  },
});
