/**
 * Filesystem Snapshot / Cleanup Manager (design.md §8).
 *
 * Captures a migration folder's complete contents (R5.1, R6.1), deletes the
 * folder (R5.2, R5.3), restores it byte-for-byte during compensating recovery
 * (R6.5), and verifies a folder against a snapshot for recovery reporting
 * (R6.6, R6.7).
 *
 * Design guarantees relied upon by the property tests (Tasks 11.2–11.3):
 * - A `capture` → `restore` → `capture` round-trip is byte-for-byte identical
 *   (Property 2). File bytes are preserved via exact base64 (no text decoding),
 *   file modes are re-applied, and `capture` output is deterministically sorted
 *   by `relativePath`.
 * - `delete` is idempotent (Property 3): deleting a folder that is already
 *   absent is a no-op reported as `{ kind: 'alreadyAbsent' }`, so repeated
 *   deletes never throw for a missing folder.
 *
 * This component uses only the Node standard library (`fs`/`fs/promises` and
 * `path`) and imports its data shapes/errors from the shared models. It does
 * not modify the models.
 */

import { promises as fsp, constants as fsConstants } from 'node:fs';
import * as path from 'node:path';

import type {
  DeleteOutcome,
  FileEntry,
  FolderSnapshot,
} from '../models/types.js';
import {
  FsDeleteError,
  RestoreError,
  SnapshotError,
} from '../models/errors.js';

/**
 * A Node.js filesystem error carries an optional string `code` (e.g. `ENOENT`,
 * `EACCES`). Narrow to this shape when inspecting caught errors.
 */
interface NodeFsError {
  code?: string;
}

/** Extract a `code` string from an unknown thrown value, if present. */
function errorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as NodeFsError).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** True when the filesystem error is a permission failure (R5.4). */
function isPermissionCode(code: string | undefined): boolean {
  return code === 'EACCES' || code === 'EPERM';
}

/** True when the filesystem error means the path does not exist. */
function isNotFoundCode(code: string | undefined): boolean {
  return code === 'ENOENT';
}

/**
 * Normalize a filesystem-relative path to POSIX form so snapshots are portable
 * and comparisons are platform-independent (R5.1). On POSIX the separators are
 * already `/`; on Windows this converts `\` to `/`.
 */
function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

/**
 * Concrete `FsSnapshotManager` implementation.
 *
 * The interface is described in design.md §8; the class is exported directly
 * (rather than as an interface) so callers can instantiate it.
 */
export class FsSnapshotManager {
  /**
   * Recursively read every file under `folderPath` into a deterministic,
   * byte-for-byte snapshot. Read-only — never mutates the filesystem
   * (R5.1, R6.1).
   *
   * Each entry records the POSIX-normalized path relative to `folderPath`, the
   * exact bytes base64-encoded, and the file mode. The resulting `files` array
   * is sorted by `relativePath` so two snapshots of identical content compare
   * equal regardless of directory-read order (enabling Property 2's round-trip
   * determinism).
   *
   * @throws {SnapshotError} if the folder cannot be read for any reason.
   */
  async capture(folderPath: string): Promise<FolderSnapshot> {
    const rootName = path.basename(folderPath);
    try {
      const files: FileEntry[] = [];
      await this.collectFiles(folderPath, folderPath, files);
      files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
      return { rootName, files };
    } catch (err) {
      throw new SnapshotError(
        `Failed to capture snapshot of folder: ${folderPath}`,
        { cause: err, folderPath }
      );
    }
  }

  /**
   * Depth-first walk that appends a `FileEntry` for every regular file found
   * under `root`. Directories are traversed but not recorded as entries (an
   * empty directory contributes nothing); the directory structure is implied by
   * the file paths and rebuilt on restore. Symbolic links to directories are not
   * followed to avoid cycles; a symlink is treated as its own target bytes via
   * `readFile`, matching how migration folders (plain files) are stored.
   */
  private async collectFiles(
    root: string,
    current: string,
    out: FileEntry[]
  ): Promise<void> {
    const dirents = await fsp.readdir(current, { withFileTypes: true });
    for (const dirent of dirents) {
      const absolute = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        await this.collectFiles(root, absolute, out);
        continue;
      }
      // Regular file (or anything readable as bytes).
      const stat = await fsp.stat(absolute);
      const content = await fsp.readFile(absolute);
      const relative = toPosix(path.relative(root, absolute));
      out.push({
        relativePath: relative,
        contentBase64: content.toString('base64'),
        mode: stat.mode,
      });
    }
  }

  /**
   * Recursively delete `folderPath`.
   *
   * A folder that does not exist is treated as already satisfied and reported
   * as `{ kind: 'alreadyAbsent' }` so the operation can continue (R5.3); this
   * also makes repeated deletes idempotent (Property 3). A successful delete is
   * reported as `{ kind: 'deleted' }` (R5.2).
   *
   * @throws {FsDeleteError} on permission or other filesystem failures (R5.4).
   *   The `isPermissionError` flag is set for `EACCES`/`EPERM`.
   */
  async delete(folderPath: string): Promise<DeleteOutcome> {
    // Determine presence first so a missing folder is a clean no-op rather than
    // relying on `rm`'s force flag (which would hide a genuine deletion).
    try {
      await fsp.access(folderPath, fsConstants.F_OK);
    } catch (err) {
      if (isNotFoundCode(errorCode(err))) {
        return { kind: 'alreadyAbsent' };
      }
      // An access failure that is not "missing" (e.g. permission on a parent)
      // is surfaced as a delete failure.
      const code = errorCode(err);
      throw new FsDeleteError(folderPath, undefined, {
        cause: err,
        isPermissionError: isPermissionCode(code),
      });
    }

    try {
      // `maxRetries`/`retryDelay` make recursive removal robust on Windows,
      // where `rm` can transiently fail with EBUSY/ENOTEMPTY/EPERM while the OS
      // releases directory handles just freed by removing their contents.
      await fsp.rm(folderPath, {
        recursive: true,
        force: false,
        maxRetries: 5,
        retryDelay: 50,
      });
      return { kind: 'deleted' };
    } catch (err) {
      const code = errorCode(err);
      // A race where the folder vanished between the access check and the rm
      // is still an "already absent" success (keeps delete idempotent).
      if (isNotFoundCode(code)) {
        return { kind: 'alreadyAbsent' };
      }
      throw new FsDeleteError(folderPath, undefined, {
        cause: err,
        isPermissionError: isPermissionCode(code),
      });
    }
  }

  /**
   * Recreate `folderPath` byte-for-byte from `snapshot` (R6.5).
   *
   * Any pre-existing content at `folderPath` is removed first so the restored
   * folder matches the snapshot exactly (no stale files linger), then each file
   * is written with its captured bytes and its captured mode is re-applied.
   * Parent directories implied by relative paths are created as needed.
   *
   * @throws {RestoreError} if the folder cannot be reconstructed.
   */
  async restore(folderPath: string, snapshot: FolderSnapshot): Promise<void> {
    try {
      // Clear any existing content so the result matches the snapshot exactly.
      await fsp.rm(folderPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
      await fsp.mkdir(folderPath, { recursive: true });

      for (const file of snapshot.files) {
        const absolute = path.join(folderPath, file.relativePath);
        await fsp.mkdir(path.dirname(absolute), { recursive: true });
        const bytes = Buffer.from(file.contentBase64, 'base64');
        await fsp.writeFile(absolute, bytes);
        // Re-apply the captured mode after writing so it is not masked by umask.
        await fsp.chmod(absolute, file.mode);
      }
    } catch (err) {
      throw new RestoreError(
        `Failed to restore folder from snapshot: ${folderPath}`,
        { cause: err, folderPath }
      );
    }
  }

  /**
   * Compare the current contents of `folderPath` against `snapshot` for
   * recovery verification (R6.6/R6.7). Returns `true` only when the folder's
   * captured form is identical to the snapshot: same `rootName`, same set of
   * files (by relative path), and, for each file, identical bytes and mode.
   *
   * A missing folder compares unequal to any snapshot that contains files (and
   * a capture of a missing folder would itself throw), so failures to read are
   * treated as "not equal" rather than propagated — the caller uses the boolean
   * result to decide whether recovery fully restored the prior state.
   */
  async equals(folderPath: string, snapshot: FolderSnapshot): Promise<boolean> {
    let current: FolderSnapshot;
    try {
      current = await this.capture(folderPath);
    } catch {
      return false;
    }

    if (current.rootName !== snapshot.rootName) {
      return false;
    }
    if (current.files.length !== snapshot.files.length) {
      return false;
    }

    // Both `files` arrays are sorted by `relativePath` (guaranteed by
    // `capture`), so a positional comparison is sufficient.
    for (let i = 0; i < current.files.length; i++) {
      const a = current.files[i];
      const b = snapshot.files[i];
      if (
        a.relativePath !== b.relativePath ||
        a.contentBase64 !== b.contentBase64 ||
        a.mode !== b.mode
      ) {
        return false;
      }
    }

    return true;
  }
}
