#!/usr/bin/env python3
"""Checks LOAD segment alignment of every ELF file under a tree (or a list of files)
with `readelf -lW`.

Usage: check-elf-alignment.py --machine aarch64|x86_64 [--min 16384] [--strict]
                              [--json out.json] PATH...

A PATH may be a directory (walked, symlinks skipped) or a file. Files are found by
their ELF magic, not their name. Only files for --machine count; ELF files for other
machines (dead weight in a bundle) are listed separately. With --strict the exit
status is 1 when any ELF for --machine with LOAD segments is aligned below --min.
"""
import argparse
import json
import os
import subprocess
import sys

MACHINES = {"x86_64": 62, "aarch64": 183}


def elf_header(path):
    try:
        with open(path, "rb") as f:
            h = f.read(20)
    except OSError:
        return None
    if len(h) < 20 or h[:4] != b"\x7fELF":
        return None
    order = "little" if h[5] == 1 else "big"
    return int.from_bytes(h[16:18], order), int.from_bytes(h[18:20], order)


def load_aligns(path):
    out = subprocess.run(["readelf", "-lW", path], capture_output=True, text=True).stdout
    aligns = []
    for line in out.splitlines():
        parts = line.split()
        if parts and parts[0] == "LOAD":
            aligns.append(int(parts[-1], 16))
    return aligns


def walk(paths):
    for p in paths:
        if os.path.isfile(p) and not os.path.islink(p):
            yield p, p
            continue
        for root, dirs, files in os.walk(p):
            for n in files:
                f = os.path.join(root, n)
                if not os.path.islink(f) and os.path.isfile(f):
                    yield f, os.path.relpath(f, p)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--machine", required=True, choices=sorted(MACHINES))
    ap.add_argument("--min", type=int, default=16384)
    ap.add_argument("--strict", action="store_true")
    ap.add_argument("--json")
    ap.add_argument("paths", nargs="+")
    a = ap.parse_args()
    want = MACHINES[a.machine]

    ok, low, noload, foreign = [], [], [], []
    for full, rel in walk(a.paths):
        h = elf_header(full)
        if h is None:
            continue
        etype, machine = h
        if machine != want:
            foreign.append({"path": rel, "machine": machine})
            continue
        aligns = load_aligns(full)
        if not aligns:
            noload.append({"path": rel, "type": etype})
            continue
        entry = {"path": rel, "minAlign": min(aligns)}
        (ok if entry["minAlign"] >= a.min else low).append(entry)

    print(f"ELF files for {a.machine}: {len(ok) + len(low)} with LOAD segments, "
          f"{len(ok)} aligned >= {a.min}, {len(low)} below; "
          f"{len(noload)} without LOAD segments (objects); {len(foreign)} for other machines")
    for e in sorted(low, key=lambda e: e["path"])[:400]:
        print(f"  LOW  0x{e['minAlign']:x}  {e['path']}")
    if len(low) > 400:
        print(f"  ... and {len(low) - 400} more")
    for e in foreign[:100]:
        print(f"  OTHER-MACHINE e_machine={e['machine']}  {e['path']}")
    aligns = {}
    for e in ok + low:
        aligns[e["minAlign"]] = aligns.get(e["minAlign"], 0) + 1
    print("  alignment histogram: " + ", ".join(f"0x{k:x}: {v}" for k, v in sorted(aligns.items())))
    if a.json:
        with open(a.json, "w") as f:
            json.dump({"machine": a.machine, "min": a.min, "checked": len(ok) + len(low),
                       "aligned": len(ok), "below": low, "histogram": {hex(k): v for k, v in sorted(aligns.items())},
                       "objectsWithoutLoad": len(noload), "otherMachine": foreign}, f, indent=2)
    if a.strict and low:
        print(f"FAIL: {len(low)} ELF files are aligned below {a.min}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
