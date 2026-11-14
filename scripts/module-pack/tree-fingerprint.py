#!/usr/bin/env python3
"""Prints a SHA-256 over the structure of a directory tree: for every entry its type,
relative path, size (files) or link target (symlinks), and mode. File contents are not
read. It is the identity of the harness tree the module pack was recorded for.

Usage: tree-fingerprint.py <dir> [--skip name]...   (names are top-level entries to leave out)
"""
import hashlib
import os
import stat
import sys


def main():
    root = os.path.abspath(sys.argv[1])
    skip = {sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--skip"}
    h = hashlib.sha256()
    count = 0
    for d, dirs, files in os.walk(root):
        rel_d = os.path.relpath(d, root)
        dirs.sort()
        names = sorted(dirs + files)
        for n in names:
            rel = os.path.normpath(os.path.join(rel_d, n))
            if rel in skip:
                continue
            st = os.lstat(os.path.join(d, n))
            if stat.S_ISLNK(st.st_mode):
                h.update(f"l {rel} {os.readlink(os.path.join(d, n))}\n".encode())
            elif stat.S_ISDIR(st.st_mode):
                h.update(f"d {rel} {st.st_mode & 0o777:o}\n".encode())
            else:
                h.update(f"f {rel} {st.st_size} {st.st_mode & 0o777:o}\n".encode())
            count += 1
        dirs[:] = [x for x in dirs if os.path.normpath(os.path.join(rel_d, x)) not in skip]
    print(h.hexdigest())
    print(f"fingerprint over {count} entries", file=sys.stderr)


if __name__ == "__main__":
    main()
