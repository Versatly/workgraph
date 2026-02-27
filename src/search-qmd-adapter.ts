/**
 * QMD-compatible search adapter.
 *
 * This package intentionally degrades gracefully to core keyword search when
 * a QMD backend is not configured.
 */

import * as query from './query.js';
import type { PrimitiveInstance } from './types.js';

export interface QmdSearchOptions {
  mode?: 'auto' | 'core' | 'qmd';
  type?: string;
  limit?: number;
}

export interface QmdSearchResult {
  mode: 'core' | 'qmd';
  query: string;
  results: PrimitiveInstance[];
  fallbackReason?: string;
}

export function search(
  workspacePath: string,
  text: string,
  options: QmdSearchOptions = {},
): QmdSearchResult {
  const requestedMode = options.mode ?? 'auto';
  const qmdEnabled = process.env.WORKGRAPH_QMD_ENDPOINT && process.env.WORKGRAPH_QMD_ENDPOINT.trim().length > 0;

  if (requestedMode === 'qmd' && !qmdEnabled) {
    const results = query.keywordSearch(workspacePath, text, {
      type: options.type,
      limit: options.limit,
    });
    return {
      mode: 'core',
      query: text,
      results,
      fallbackReason: 'QMD mode requested but WORKGRAPH_QMD_ENDPOINT is not configured.',
    };
  }

  if (requestedMode === 'qmd' && qmdEnabled) {
    // MVP: route to core search while preserving mode contract.
    const results = query.keywordSearch(workspacePath, text, {
      type: options.type,
      limit: options.limit,
    });
    return {
      mode: 'qmd',
      query: text,
      results,
      fallbackReason: 'QMD endpoint configured; using core-compatible local ranking in MVP.',
    };
  }

  if (requestedMode === 'auto' && qmdEnabled) {
    const results = query.keywordSearch(workspacePath, text, {
      type: options.type,
      limit: options.limit,
    });
    return {
      mode: 'qmd',
      query: text,
      results,
      fallbackReason: 'Auto mode selected; QMD endpoint detected; using core-compatible local ranking in MVP.',
    };
  }

  return {
    mode: 'core',
    query: text,
    results: query.keywordSearch(workspacePath, text, {
      type: options.type,
      limit: options.limit,
    }),
  };
}
