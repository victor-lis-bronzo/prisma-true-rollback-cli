// Feature: prisma-true-rollback-cli, Property 2: Snapshot round-trip is a byte-for-byte identity
import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FsSnapshotManager } from '../../src/snapshot/fs-snapshot-manager.js';

/**
 * Property 2: Snapshot round-trip is a byte-for-byte identity (design.md
 * §Correctness Property 2).
 *
 * *For any* migration-folder contents, capturing a FolderSnapshot and then
 * restoring from it — both to a fresh location and after deleting the original
 * folder — SHALL reproduce the folder so that every file's relative path,
 * bytes, and mode are identical to the original.
 *
 * The test generates arbitrary nested folder trees (valid, traversal-free
 * relative paths with subdirectories, arbitrary binary/text byte contents that
 * may be empty, and arbitrary file modes), materializes them on a real temp
 * directory, and asserts:
 *   1. capture → restore into a fresh location yields a folder whose capture is
 *      identical to the original snapshot (same set of relative paths, bytes,
 *      and modes), and
 *   2. capture → delete original → restore back into the (now absent) original
 *      location yields the same identity.
 *
 * Identity is asserted both via the manager's own `equals` and by an
 * independent re-`capture` + structural comparison, so the assertion does not
 * rely solely on the code under test's comparison logic.
 *
 * Validates: Requirements 5.1, 6.5
 */
describe('Property 2: Snapshot round-trip is a byte-for-byte identity', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    // Clean up every temp dir created during the run.
    await Promise.all(
      tempRoots.splice(0).map((dir) =>
        fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined),
      ),
    );
  });

  async function makeTempDir(): Promise<string> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ptrb-snap-'));
    tempRoots.push(dir);
    return dir;
  }

  // A single, safe path segment: no separators, no traversal, no NUL, and not
  // "." or "..". Restricted to a portable character set so it is a valid file
  // name on the running platform.
  const pathSegment = (): fc.Arbitrary<string> =>
    fc
      .stringMatching(/^[A-Za-z0-9._-]{1,12}$/)
      .filter((s) => s !== '.' && s !== '..');

  // A relative file path with 0..2 nested directory segments followed by a file
  // segment. Always relative, never contains ".." and never absolute.
  const relativeFilePath = (): fc.Arbitrary<string> =>
    fc
      .array(pathSegment(), { minLength: 0, maxLength: 2 })
      .chain((dirs) =>
        pathSegment().map((file) => [...dirs, file].join('/')),
      );

  // Arbitrary byte content, possibly empty, covering the full 0..255 byte range
  // so both text and binary payloads are exercised.
  const fileContent = (): fc.Arbitrary<Buffer> =>
    fc
      .array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength: 64 })
      .map((bytes) => Buffer.from(bytes));

  // File permission bits. Keep them readable/writable by the owner so cleanup
  // and re-capture always succeed, while still varying group/other bits.
  const fileMode = (): fc.Arbitrary<number> =>
    fc.integer({ min: 0, max: 0o777 }).map((m) => 0o600 | m);

  // A whole folder tree: a set of files keyed by unique relative path.
  const folderTree = (): fc.Arbitrary<
    Array<{ relativePath: string; content: Buffer; mode: number }>
  > =>
    fc
      .array(
        fc.record({
          relativePath: relativeFilePath(),
          content: fileContent(),
          mode: fileMode(),
        }),
        { minLength: 0, maxLength: 8 },
      )
      // De-duplicate by relative path: the same path written twice would be a
      // single file on disk, which is not a meaningful multi-file scenario.
      // Also drop entries whose path prefix collides with an existing file
      // (a file cannot also be a directory).
      .map((entries) => {
        const chosen: Array<{
          relativePath: string;
          content: Buffer;
          mode: number;
        }> = [];
        const usedPaths = new Set<string>();
        const filePaths = new Set<string>();
        const dirPaths = new Set<string>();

        for (const entry of entries) {
          const rel = entry.relativePath;
          if (usedPaths.has(rel)) continue;

          const segments = rel.split('/');
          const dirSegments = segments.slice(0, -1);

          // A directory ancestor of this file must not already be a file.
          let prefix = '';
          let conflict = filePaths.has(rel);
          const ancestorDirs: string[] = [];
          for (const seg of dirSegments) {
            prefix = prefix ? `${prefix}/${seg}` : seg;
            ancestorDirs.push(prefix);
            if (filePaths.has(prefix)) {
              conflict = true;
              break;
            }
          }
          // This file's own path must not already be an existing directory.
          if (dirPaths.has(rel)) conflict = true;
          if (conflict) continue;

          chosen.push(entry);
          usedPaths.add(rel);
          filePaths.add(rel);
          for (const d of ancestorDirs) dirPaths.add(d);
        }
        return chosen;
      });

  // Materialize a generated tree under `root`, applying each file's mode.
  async function writeTree(
    root: string,
    tree: Array<{ relativePath: string; content: Buffer; mode: number }>,
  ): Promise<void> {
    for (const file of tree) {
      const absolute = path.join(root, file.relativePath);
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      await fsp.writeFile(absolute, file.content);
      await fsp.chmod(absolute, file.mode);
    }
  }

  // Structurally compare two captured snapshots for byte-for-byte identity,
  // independent of the manager's own `equals`.
  function expectSnapshotsIdentical(
    actual: { files: Array<{ relativePath: string; contentBase64: string; mode: number }> },
    expected: { files: Array<{ relativePath: string; contentBase64: string; mode: number }> },
  ): void {
    // Same set of relative paths.
    const actualPaths = actual.files.map((f) => f.relativePath).sort();
    const expectedPaths = expected.files.map((f) => f.relativePath).sort();
    expect(actualPaths).toEqual(expectedPaths);

    const byPath = new Map(actual.files.map((f) => [f.relativePath, f]));
    for (const exp of expected.files) {
      const got = byPath.get(exp.relativePath);
      expect(got).toBeDefined();
      // Identical bytes.
      expect(got!.contentBase64).toBe(exp.contentBase64);
      // Identical mode (compare permission bits, which restore re-applies).
      expect(got!.mode & 0o777).toBe(exp.mode & 0o777);
    }
  }

  it('reproduces every file path, bytes, and mode after restore to a fresh location and after delete (>=100 runs)', async () => {
    const manager = new FsSnapshotManager();

    await fc.assert(
      fc.asyncProperty(folderTree(), async (tree) => {
        const workspace = await makeTempDir();
        const originalDir = path.join(workspace, 'migration');
        await fsp.mkdir(originalDir, { recursive: true });
        await writeTree(originalDir, tree);

        // Baseline snapshot of the original folder.
        const original = await manager.capture(originalDir);

        // --- Case 1: restore into a fresh location -------------------------
        // Restore to a different, non-existent path so we exercise a "fresh"
        // target that shares the same basename (rootName) as the original.
        const freshTarget = path.join(workspace, 'restored', 'migration');
        await manager.restore(freshTarget, original);

        const restoredFresh = await manager.capture(freshTarget);
        expectSnapshotsIdentical(restoredFresh, original);
        // The manager's own equality check must also agree.
        expect(await manager.equals(freshTarget, original)).toBe(true);

        // --- Case 2: delete the original, then restore it back -------------
        const del = await manager.delete(originalDir);
        expect(del.kind).toBe('deleted');
        // Confirm it is gone.
        await expect(fsp.access(originalDir)).rejects.toBeDefined();

        await manager.restore(originalDir, original);
        const restoredAfterDelete = await manager.capture(originalDir);
        expectSnapshotsIdentical(restoredAfterDelete, original);
        expect(await manager.equals(originalDir, original)).toBe(true);

        return true;
      }),
      { numRuns: 100 },
    );
  }, 60_000);
});
