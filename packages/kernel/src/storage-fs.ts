import nodeFs from 'node:fs';
import { getStorageAdapterForPath, LocalStorageAdapter } from './storage.js';

const FALLBACK_ADAPTER = new LocalStorageAdapter();

const storageFs = {
  constants: nodeFs.constants,
  existsSync(targetPath: string): boolean {
    return getStorageAdapterForPath(targetPath).existsSync(targetPath);
  },
  readFileSync(targetPath: string, options?: any): any {
    return getStorageAdapterForPath(targetPath).readFileSync(targetPath, options);
  },
  writeFileSync(targetPath: string | number, data: any, options?: any): void {
    getStorageAdapterForPath(targetPath).writeFileSync(targetPath, data, options);
  },
  appendFileSync(targetPath: string, data: any, options?: any): void {
    getStorageAdapterForPath(targetPath).appendFileSync(targetPath, data, options);
  },
  mkdirSync(targetPath: string, options?: any): any {
    return getStorageAdapterForPath(targetPath).mkdirSync(targetPath, options);
  },
  rmSync(targetPath: string, options?: any): any {
    return getStorageAdapterForPath(targetPath).rmSync(targetPath, options);
  },
  renameSync(oldPath: string, newPath: string): void {
    getStorageAdapterForPath(oldPath).renameSync(oldPath, newPath);
  },
  readdirSync(targetPath: string, options?: any): any {
    return getStorageAdapterForPath(targetPath).readdirSync(targetPath, options);
  },
  openSync(targetPath: string, flags: string | number, mode?: any): number {
    return getStorageAdapterForPath(targetPath).openSync(targetPath, flags, mode);
  },
  closeSync(fd: number): void {
    FALLBACK_ADAPTER.closeSync(fd);
  },
  statSync(targetPath: string, options?: any): nodeFs.Stats {
    return getStorageAdapterForPath(targetPath).statSync(targetPath, options);
  },
  lstatSync(targetPath: string, options?: any): nodeFs.Stats {
    return getStorageAdapterForPath(targetPath).lstatSync(targetPath, options);
  },
  mkdtempSync(prefix: string, options?: any): string {
    return getStorageAdapterForPath(prefix).mkdtempSync(prefix, options);
  },
  cpSync(src: string, dest: string, options?: any): void {
    getStorageAdapterForPath(src).cpSync(src, dest, options);
  },
  copyFileSync(src: string, dest: string, mode?: number): void {
    getStorageAdapterForPath(src).copyFileSync(src, dest, mode);
  },
};

export default storageFs as unknown as typeof nodeFs;
