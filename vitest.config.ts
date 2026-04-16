import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.{test,spec}.ts',
      'packages/*/tests/**/*.{test,spec}.ts',
      'tests/**/*.{test,spec}.ts',
    ],
    exclude: [
      'packages/kernel/src/agent-self-assembly.test.ts',
      'packages/kernel/src/dispatch*.test.ts',
      'packages/kernel/src/diagnostics.test.ts',
      'packages/kernel/src/gate.test.ts',
      'packages/kernel/src/mission-orchestrator.test.ts',
      'packages/kernel/src/projections/**/*.test.ts',
      'packages/kernel/src/reconciler.test.ts',
      'packages/kernel/src/schema-drift-regression.test.ts',
      'packages/kernel/src/trigger*.test.ts',
      'packages/kernel/src/workspace-structure.test.ts',
      'tests/integration/cli-compat.test.ts',
      'tests/integration/multi-agent-showcase.test.ts',
      'tests/integration/portability-cli.test.ts',
      'tests/integration/remote-cli.test.ts',
      'tests/integration/trigger-cli.test.ts',
      'tests/stress/capability-matching.test.ts',
      'tests/stress/federation-scale.test.ts',
      'tests/stress/full-lifecycle.test.ts',
      'tests/stress/trigger-cascade.test.ts',
      'tests/stress/webhook-flood.test.ts',
    ],
  },
});
