import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initWorkspace } from './workspace.js';
import * as thread from './thread.js';
import {
  LocalStorageAdapter,
  clearStorageAdapter,
  getStorageAdapter,
  registerStorageAdapter,
} from './storage.js';

class TrackingStorageAdapter extends LocalStorageAdapter {
  public writeCount = 0;
  public mkdirCount = 0;

  public writeFileSync(...args: any[]): void {
    this.writeCount += 1;
    super.writeFileSync(...args);
  }

  public mkdirSync(...args: any[]): any {
    this.mkdirCount += 1;
    return super.mkdirSync(...args);
  }
}

describe('storage adapter', () => {
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-storage-'));
  });

  afterEach(() => {
    clearStorageAdapter(workspacePath);
    fs.rmSync(workspacePath, { recursive: true, force: true });
    delete process.env.WORKGRAPH_STORAGE_MODE;
  });

  it('defaults to local adapter mode', () => {
    initWorkspace(workspacePath);
    const adapter = getStorageAdapter(workspacePath);
    expect(adapter.kind).toBe('local');
  });

  it('resolves cloud mode from environment', () => {
    process.env.WORKGRAPH_STORAGE_MODE = 'cloud';
    initWorkspace(workspacePath);
    const adapter = getStorageAdapter(workspacePath);
    expect(adapter.kind).toBe('cloud');
  });

  it('routes kernel file writes through registered adapter', () => {
    const trackingAdapter = new TrackingStorageAdapter();
    registerStorageAdapter(workspacePath, trackingAdapter);

    initWorkspace(workspacePath);
    thread.createThread(workspacePath, 'Adapter routed thread', 'Verify adapter path', 'agent-storage');

    expect(trackingAdapter.writeCount).toBeGreaterThan(0);
    expect(trackingAdapter.mkdirCount).toBeGreaterThan(0);
  });
});
