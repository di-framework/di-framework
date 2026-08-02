import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SCRIPT_PATH = join(import.meta.dir, '..', 'scripts', 'e2e-test.sh');
const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

describe('test command', () => {
  describe('paths', () => {
    it('e2e script exists at the source path', () => {
      expect(existsSync(SCRIPT_PATH)).toBe(true);
    });

    it('e2e script is a bash script', () => {
      const content = readFileSync(SCRIPT_PATH, 'utf-8');
      expect(content.startsWith('#!/bin/bash')).toBe(true);
    });

    it('repo root contains package.json', () => {
      expect(existsSync(join(REPO_ROOT, 'package.json'))).toBe(true);
    });

    it('repo root contains the packages directory', () => {
      expect(existsSync(join(REPO_ROOT, 'packages'))).toBe(true);
    });
  });

  describe('e2e script content', () => {
    it('runs type checks', () => {
      const content = readFileSync(SCRIPT_PATH, 'utf-8');
      expect(content).toContain('TypeScript type check');
    });

    it('runs unit tests', () => {
      const content = readFileSync(SCRIPT_PATH, 'utf-8');
      expect(content).toContain('bun test');
    });

    it('validates examples', () => {
      const content = readFileSync(SCRIPT_PATH, 'utf-8');
      expect(content).toContain('Validating example code');
    });

    it('reports a summary', () => {
      const content = readFileSync(SCRIPT_PATH, 'utf-8');
      expect(content).toContain('Test Summary');
    });
  });

  describe('embedded script', () => {
    it('is read into the module at import time', async () => {
      const mod = await import('../cmd/test');
      expect(mod.test).toBeFunction();
    });
  });
});
