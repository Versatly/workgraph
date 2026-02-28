import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./query.js', () => ({
  keywordSearch: vi.fn(),
}));

import * as query from './query.js';
import type { PrimitiveInstance } from './types.js';
import { search } from './search-qmd-adapter.js';

describe('search-qmd-adapter', () => {
  const keywordSearchMock = vi.mocked(query.keywordSearch);
  const envSnapshot = process.env.WORKGRAPH_QMD_ENDPOINT;
  const fakeResults: PrimitiveInstance[] = [
    {
      path: 'facts/result.md',
      type: 'fact',
      body: '# Result',
      fields: {
        title: 'Result',
      },
    },
  ];

  beforeEach(() => {
    delete process.env.WORKGRAPH_QMD_ENDPOINT;
    keywordSearchMock.mockReset();
    keywordSearchMock.mockReturnValue(fakeResults);
  });

  afterEach(() => {
    if (envSnapshot === undefined) {
      delete process.env.WORKGRAPH_QMD_ENDPOINT;
    } else {
      process.env.WORKGRAPH_QMD_ENDPOINT = envSnapshot;
    }
  });

  it('uses core mode when requested explicitly', () => {
    const result = search('/workspace/demo', 'critical bug', {
      mode: 'core',
      type: 'thread',
      limit: 3,
    });

    expect(result.mode).toBe('core');
    expect(result.fallbackReason).toBeUndefined();
    expect(result.results).toEqual(fakeResults);
    expect(keywordSearchMock).toHaveBeenCalledWith('/workspace/demo', 'critical bug', {
      type: 'thread',
      limit: 3,
    });
  });

  it('falls back to core mode when qmd mode is requested but endpoint is missing', () => {
    const result = search('/workspace/demo', 'release check', {
      mode: 'qmd',
      type: 'thread',
      limit: 5,
    });

    expect(result.mode).toBe('core');
    expect(result.fallbackReason).toContain('WORKGRAPH_QMD_ENDPOINT is not configured');
    expect(keywordSearchMock).toHaveBeenCalledWith('/workspace/demo', 'release check', {
      type: 'thread',
      limit: 5,
    });
  });

  it('returns qmd mode contract when endpoint is configured and qmd mode is requested', () => {
    process.env.WORKGRAPH_QMD_ENDPOINT = 'https://qmd.example/search';
    const result = search('/workspace/demo', 'incident summary', {
      mode: 'qmd',
    });

    expect(result.mode).toBe('qmd');
    expect(result.fallbackReason).toContain('QMD endpoint configured');
    expect(result.results).toEqual(fakeResults);
  });

  it('auto-selects qmd mode when endpoint is configured', () => {
    process.env.WORKGRAPH_QMD_ENDPOINT = 'https://qmd.example/search';
    const result = search('/workspace/demo', 'deploy plan');

    expect(result.mode).toBe('qmd');
    expect(result.fallbackReason).toContain('Auto mode selected');
    expect(keywordSearchMock).toHaveBeenCalledWith('/workspace/demo', 'deploy plan', {
      type: undefined,
      limit: undefined,
    });
  });
});
