#!/usr/bin/env python3
"""Records the state of the base tree so the harness install can be proven to
touch nothing outside the harness layer.

  tree-snapshot.py save <root> <out.json>
  tree-snapshot.py compare <before.json> <after.json>    (exit 1 on any difference)

Skipped: dev, proc, sys, tmp, and the harness layer paths (opt/dsh, usr/local/bin/dsh).
Directory modification times are ignored; everything else (type, mode, size,
mtime of files, symlink target) is compared.
"""
import json
import os
import stat
import sys

SKIP = {"dev", "proc", "sys", "tmp", "opt/dsh", "usr/local/bin/dsh"}


def save(root, out):
    state = {}
    for d, dirs, files in os.walk(root):
        rel_d = os.path.relpath(d, root)
        rel_d = "" if rel_d == "." else rel_d
        dirs[:] = [x for x in dirs if os.path.join(rel_d, x).lstrip("/") not in SKIP]
        for n in dirs + files:
            rel = os.path.join(rel_d, n).lstrip("/")
            if rel in SKIP:
                continue
            st = os.lstat(os.path.join(root, rel))
            if stat.S_ISDIR(st.st_mode):
                state[rel] = ["d", st.st_mode]
            elif stat.S_ISLNK(st.st_mode):
                state[rel] = ["l", os.readlink(os.path.join(root, rel))]
            else:
                state[rel] = ["f", st.st_mode, st.st_size, st.st_mtime_ns]
    with open(out, "w") as f:
        json.dump(state, f)
    print(f"snapshot: {len(state)} entries")


def compare(a_path, b_path):
    a, b = json.load(open(a_path)), json.load(open(b_path))
    diffs = []
    for k in sorted(set(a) | set(b)):
        if k not in a:
            diffs.append(f"added    {k}")
        elif k not in b:
            diffs.append(f"removed  {k}")
        elif a[k] != b[k]:
            diffs.append(f"changed  {k}  {a[k]} -> {b[k]}")
    for line in diffs[:200]:
        print(line)
    if diffs:
        print(f"FAIL: the harness install changed {len(diffs)} paths outside the harness layer")
        return 1
    print("base tree unchanged by the harness install")
    return 0


if __name__ == "__main__":
    if sys.argv[1] == "save":
        save(sys.argv[2], sys.argv[3])
    else:
        sys.exit(compare(sys.argv[2], sys.argv[3]))
