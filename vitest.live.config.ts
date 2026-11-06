import { defineConfig } from 'vitest/config';

// Tests que llaman a Claude de verdad (necesitan ANTHROPIC_API_KEY): `pnpm test:live`
export default defineConfig({
  test: {
    include: ['test/**/*.live.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
