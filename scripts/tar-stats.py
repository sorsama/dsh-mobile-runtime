#!/usr/bin/env python3
"""Validates a layer tar and prints its statistics as JSON.

Rules a layer must follow (the Android extractor relies on them):
  * only regular files, directories and symbolic links (no hard links, devices, FIFOs);
  * member names are relative, with no "." or ".." components and no leading "./";
  * no member name repeats.

Usage: tar-stats.py <layer.tar> > stats.json
"""
import json
import sys
import tarfile


def main():
    path = sys.argv[1]
    entries = files = dirs = links = 0
    file_bytes = 0
    longest = 0
    seen = set()
    problems = []
    with tarfile.open(path, "r:") as t:
        for m in t:
            entries += 1
            name = m.name
            longest = max(longest, len(name.encode()))
            parts = name.split("/")
            if name.startswith("/") or name.startswith("./") or any(p in ("", ".", "..") for p in parts):
                problems.append(f"bad name: {name!r}")
            if name in seen:
                problems.append(f"duplicate: {name!r}")
            seen.add(name)
            if m.isreg():
                files += 1
                file_bytes += m.size
            elif m.isdir():
                dirs += 1
            elif m.issym():
                links += 1
            else:
                problems.append(f"unsupported type {m.type!r}: {name!r}")
    if problems:
        for p in problems[:50]:
            print(p, file=sys.stderr)
        print(f"{len(problems)} problems in {path}", file=sys.stderr)
        sys.exit(1)
    json.dump({"entries": entries, "files": files, "directories": dirs, "symlinks": links,
               "fileBytes": file_bytes, "longestNameBytes": longest}, sys.stdout)
    print()


if __name__ == "__main__":
    main()
