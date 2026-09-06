// Open a path and confirm it's a regular file without a check-then-use gap.
//
// Checking a path (existsSync/statSync) and then reading it separately
// (readFileSync-by-path) leaves a window where the path can start pointing
// somewhere else before the read lands — a symlink swapped in after the
// check, or, for a path a caller doesn't control (a model-supplied citation,
// a file discovered by walking a git checkout that may itself contain a
// committed symlink), one that was already a symlink at check time and simply
// resolved to something outside the tree the caller believes it's confined
// to. `openRegularFileSync` closes both: O_NOFOLLOW makes the kernel refuse
// to open the final path component at all if it is a symlink, and the file-
// type check runs against the descriptor the caller goes on to read from,
// not a second path lookup.

import { constants, closeSync, fstatSync, openSync } from 'node:fs';

// O_NONBLOCK matters as much as O_NOFOLLOW here. Opening a FIFO for reading
// BLOCKS until a writer appears, and the paths this opens come from reviewer
// JSON — a checkout containing a committed FIFO (git stores mode 010000), or a
// path pointing at one, hung the triage bridge forever with no output and no
// timeout. The descriptor is only ever fstat'd and read as a regular file, so
// non-blocking costs nothing: `openRegularFileSync` rejects anything that is
// not a regular file, and a regular file ignores the flag.
const READ_FLAGS = constants.O_RDONLY
  | (constants.O_NOFOLLOW ?? 0)
  | (constants.O_NONBLOCK ?? 0);

// Throws exactly where `openSync` would (ENOENT, ELOOP for a symlink,
// EACCES, …). Returns null only once the path opened but the descriptor
// isn't a regular file (a directory, FIFO, device, socket).
export function openRegularFileSync(filePath) {
  const fd = openSync(filePath, READ_FLAGS);
  // `fstatSync` can throw (EIO, EBADF), and this module exists to make the
  // claim-checker's read safe — so the one path out of it that was not a clean
  // return must not be the one that leaks. Triage opens a descriptor per cited
  // path, so a run where fstat keeps failing exhausted them.
  try {
    if (fstatSync(fd).isFile()) return fd;
  } catch (e) {
    closeQuietly(fd);
    throw e;
  }
  closeSync(fd);
  return null;
}

// A close failure (EBADF, or EIO flushing on some filesystems) is not a
// reason to abort whatever the caller was doing with the file's contents —
// it already has everything it's going to get from the descriptor.
export function closeQuietly(fd) {
  try {
    closeSync(fd);
  } catch {
    // nothing to salvage
  }
}
