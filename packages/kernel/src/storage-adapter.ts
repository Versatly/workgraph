import fs from 'node:fs';
import path from 'node:path';

export type StorageAdapterKind = 'local' | 'cloud';

export interface StorageAdapter {
  readonly kind: StorageAdapterKind;
  resolve(targetPath: string): string;
  exists(targetPath: string): boolean;
  readFile(targetPath: string, encoding?: BufferEncoding): string;
  writeFile(targetPath: string, data: string | Uint8Array): void;
  mkdir(targetPath: string, options?: { recursive?: boolean }): void;
  readdir(targetPath: string): string[];
  rm(targetPath: string, options?: { recursive?: boolean; force?: boolean }): void;
  cp(
    sourcePath: string,
    destinationPath: string,
    options?: { recursive?: boolean; force?: boolean; errorOnExist?: boolean },
  ): void;
  stat(targetPath: string): fs.Stats;
}

export interface LocalStorageAdapterOptions {
  rootPath?: string;
}

export class LocalStorageAdapter implements StorageAdapter {
  readonly kind = 'local' as const;
  private readonly rootPath?: string;

  constructor(options: LocalStorageAdapterOptions = {}) {
    this.rootPath = options.rootPath ? path.resolve(options.rootPath) : undefined;
  }

  resolve(targetPath: string): string {
    if (path.isAbsolute(targetPath)) return targetPath;
    if (!this.rootPath) return path.resolve(targetPath);
    return path.resolve(this.rootPath, targetPath);
  }

  exists(targetPath: string): boolean {
    return fs.existsSync(this.resolve(targetPath));
  }

  readFile(targetPath: string, encoding: BufferEncoding = 'utf-8'): string {
    return fs.readFileSync(this.resolve(targetPath), encoding);
  }

  writeFile(targetPath: string, data: string | Uint8Array): void {
    fs.writeFileSync(this.resolve(targetPath), data);
  }

  mkdir(targetPath: string, options: { recursive?: boolean } = {}): void {
    fs.mkdirSync(this.resolve(targetPath), { recursive: options.recursive === true });
  }

  readdir(targetPath: string): string[] {
    return fs.readdirSync(this.resolve(targetPath));
  }

  rm(targetPath: string, options: { recursive?: boolean; force?: boolean } = {}): void {
    fs.rmSync(this.resolve(targetPath), {
      recursive: options.recursive === true,
      force: options.force === true,
    });
  }

  cp(
    sourcePath: string,
    destinationPath: string,
    options: { recursive?: boolean; force?: boolean; errorOnExist?: boolean } = {},
  ): void {
    fs.cpSync(this.resolve(sourcePath), this.resolve(destinationPath), {
      recursive: options.recursive === true,
      force: options.force ?? true,
      errorOnExist: options.errorOnExist === true,
    });
  }

  stat(targetPath: string): fs.Stats {
    return fs.statSync(this.resolve(targetPath));
  }
}

// Stub contract for future cloud-backed implementations.
export interface CloudStorageAdapter extends StorageAdapter {
  readonly kind: 'cloud';
  readonly provider: string;
  readonly bucketOrNamespace: string;
  toObjectUri(targetPath: string): string;
}
