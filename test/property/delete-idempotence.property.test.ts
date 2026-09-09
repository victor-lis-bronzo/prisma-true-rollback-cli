// Feature: prisma-true-rollback-cli, Property 3: Delete semantics and idempotence
import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FsSnapshotManager } from '../../src/snapshot/fs-snapshot-manager.js';

/**
 * Property 3: Delete semantics and idempotence (design.md §Correctness
 * Property 3, Validates Requirements 5.2, 5.3).
 *
 * For any migration-folder-shaped tree (arbitrary nested files and
 * subdirectories) created under a real temp directory:
 *   1. delete() removes it entirely — nothing remains on disk — and reports
 *      `{ kind: 'deleted' }`.
 *   2. For any path that does not exist, delete() is a no-op reported as
 *      `{ kind: 'alreadyAbsent' }`.
 *   3. Deleting twice yields the same result as deleting once: the second
 *      delete of the (now-removed) folder returns `{ kind: 'alreadyAbsent' }`.
 *
 * Real temp directories are used (no in-memory fs). Every temp root created by
 * the test is tracked and removed in afterEach so no scratch state leaks.
 */
describe('Property 3: delete semantics and idempotence', () => {
  // Track every temp root we create so cleanup is guaranteed even if a
  // property run throws before its own cleanup.
  const tempRoots: string[] = [];

  afterEach(async () => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop()!;
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  async function makeTempRoot(): Promise<string> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ptr-delete-'));
    tempRoots.push(root);
    return root;
  }

  // A single path segment: safe on all platforms (alphanumerics, dash,
  // underscore, dot), non-empty, and never "." or ".." so it always names a
  // real child rather than a traversal.
  const segment = (): fc.Arbitrary<string> =>
    fc
      .stringMatching(/^[A-Za-z0-9_-]{1,12}$/)
      .filter((s) => s !== '.' && s !== '..');

  // A node in a generated folder tree: either a file (with byte content) or a
  // directory containing further nodes. Bounded depth/size keeps IO cheap.
  type TreeNode =
    | { type: 'file'; name: string; content: Uint8Array }
    | { type: 'dir'; name: string; children: TreeNode[] };

  const fileNode = (): fc.Arbitrary<TreeNode> =>
    fc.record({
      type: fc.constant<'file'>('file'),
      name: segment(),
      content: fc.uint8Array({ maxLength: 64 }),
    });

  const treeNode = (): fc.Arbitrary<TreeNode> =>
    fc.letrec<{ node: TreeNode }>((tie) => ({
      node: fc.oneof(
        { depthSize: 'small', withCrossShrink: true },
        fileNode(),
        fc.record({
          type: fc.constant<'dir'>('dir'),
          name: segment(),
          children: fc.array(tie('node'), { maxLength: 4 }),
        }),
      ),
    })).node;

  // Materialize a list of tree nodes under `dir` on the real filesystem.
  // Name collisions within a directory are resolved by suffixing so every
  // generated node is written (an arbitrary but valid folder shape).
  async function writeTree(dir: string, nodes: TreeNode[]): Promise<void> {
    const used = new Set<string>();
    for (const node of nodes) {
      let name = node.name;
      let i = 0;
      while (used.has(name)) {
        i += 1;
        name = `${node.name}_${i}`;
      }
      used.add(name);
      const target = path.join(dir, name);
      if (node.type === 'file') {
        await fsp.writeFile(target, Buffer.from(node.content));
      } else {
        await fsp.mkdir(target);
        await writeTree(target, node.children);
      }
    }
  }

  async function exists(p: string): Promise<boolean> {
    try {
      await fsp.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  it('deletes an arbitrary folder entirely and is idempotent (>=100 runs)', async () => {
    const manager = new FsSnapshotManager();

    await fc.assert(
      fc.asyncProperty(
        fc.array(treeNode(), { maxLength: 6 }),
        segment(),
        async (nodes, folderName) => {
          const root = await makeTempRoot();
          const folderPath = path.join(root, folderName);
          await fsp.mkdir(folderPath);
          await writeTree(folderPath, nodes);

          // Sanity: the folder we are about to delete exists.
          expect(await exists(folderPath)).toBe(true);

          // (1) First delete removes the folder and everything under it.
          const first = await manager.delete(folderPath);
          expect(first).toEqual({ kind: 'deleted' });
          expect(await exists(folderPath)).toBe(false);

          // (3) Deleting twice equals deleting once: the second delete is a
          //     no-op reported as already-absent.
          const second = await manager.delete(folderPath);
          expect(second).toEqual({ kind: 'alreadyAbsent' });
          expect(await exists(folderPath)).toBe(false);

          return true;
        },
      ),
      { numRuns: 100 },
    );
    // FS-heavy on slower platforms (notably Windows), so allow generous time.
  }, 60_000);

  it('deleting a path that never existed is a no-op reported as already-absent (>=100 runs)', async () => {
    const manager = new FsSnapshotManager();

    await fc.assert(
      fc.asyncProperty(
        // A relative path of one or more segments that we never create.
        fc.array(segment(), { minLength: 1, maxLength: 4 }),
        async (segments) => {
          const root = await makeTempRoot();
          const missingPath = path.join(root, ...segments);

          // Guard: the path genuinely does not exist.
          expect(await exists(missingPath)).toBe(false);

          const outcome = await manager.delete(missingPath);
          expect(outcome).toEqual({ kind: 'alreadyAbsent' });

          // Still absent, and delete introduced nothing.
          expect(await exists(missingPath)).toBe(false);

          return true;
        },
      ),
      { numRuns: 100 },
    );
    // FS-heavy on slower platforms (notably Windows), so allow generous time.
  }, 60_000);
});
