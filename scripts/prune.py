#!/usr/bin/env python3
"""Conservative pruning of node_modules: remove only prebuilt native binaries
for other operating systems or other CPU architectures.

A directory is removed only when all of these hold:
  * its name is an OS/arch tuple (for example darwin-arm64, win32-x64, win10-arm64,
    linux-arm64 on an x86_64 bundle, musl_arm64 on an x86_64 bundle);
  * that tuple is not Linux on the bundle's own architecture;
  * it is not a package root (no package.json) and holds no JavaScript, JSON,
    TypeScript or WebAssembly files, only binaries and data;
  * it holds at least one native binary (ELF, Mach-O or PE), and no ELF for the
    bundle's own machine.
Everything else stays, including musl builds for the bundle's own architecture.

Usage: prune.py <node_modules> <arch: arm64|x64> <report.json>
"""
import json
import os
import re
import shutil
import sys

ARCH_ALIASES = {
    "x64": "x64", "x86_64": "x64", "amd64": "x64",
    "arm64": "arm64", "aarch64": "arm64",
    "arm": "arm", "armhf": "arm", "armv6": "arm", "armv6l": "arm", "armv7": "arm", "armv7l": "arm", "armel": "arm",
    "ia32": "ia32", "x86": "ia32", "i386": "ia32", "i686": "ia32",
    "riscv64": "riscv64", "ppc64": "ppc64", "ppc64le": "ppc64le", "s390x": "s390x",
    "loong64": "loong64", "mips64el": "mips64el", "mipsel": "mipsel", "universal": "universal",
}
OTHER_OS = {"darwin", "macos", "mac", "osx", "win32", "win", "win10", "win11", "windows",
            "freebsd", "openbsd", "netbsd", "sunos", "solaris", "aix", "android", "ios", "haiku"}
LINUX_LIBC = {"linux", "musl", "linuxmusl", "glibc", "gnu"}
TEXTY = re.compile(r"\.(m?js|cjs|json|ts|mts|cts|wasm|node\.js)$", re.I)
ELF_MACHINE = {"x64": 62, "arm64": 183}


def magic(path):
    try:
        with open(path, "rb") as f:
            head = f.read(20)
    except OSError:
        return None, None
    if head[:4] == b"\x7fELF":
        little = head[5] == 1
        machine = int.from_bytes(head[18:20], "little" if little else "big")
        return "elf", machine
    if head[:4] in (b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf", b"\xce\xfa\xed\xfe", b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe"):
        return "macho", None
    if head[:2] == b"MZ":
        return "pe", None
    return None, None


def classify(name, target):
    tokens = re.split(r"[-_]", name.lower())
    if len(tokens) < 2:
        return None
    os_part = tokens[0]
    # "x86_64" spans two tokens; try the longer form first.
    arch = None
    if len(tokens) >= 3:
        arch = ARCH_ALIASES.get(tokens[1] + "_" + tokens[2])
    if arch is None:
        arch = ARCH_ALIASES.get(tokens[1])
    if arch is None:
        return None
    if os_part in OTHER_OS:
        return f"other OS ({os_part})"
    if os_part in LINUX_LIBC and arch != target:
        return f"other architecture ({arch})"
    return None


def scan(path):
    files, texty, native, own_elf, size = 0, False, 0, False, 0
    for root, dirs, names in os.walk(path):
        for n in names:
            p = os.path.join(root, n)
            if os.path.islink(p):
                continue
            files += 1
            size += os.path.getsize(p)
            if TEXTY.search(n) or n == "package.json":
                texty = True
            kind, machine = magic(p)
            if kind:
                native += 1
            if kind == "elf" and machine == TARGET_MACHINE:
                own_elf = True
    return files, texty, native, own_elf, size


def main():
    global TARGET_MACHINE
    nm, target, report_path = sys.argv[1], ARCH_ALIASES[sys.argv[2]], sys.argv[3]
    TARGET_MACHINE = ELF_MACHINE[target]
    removed, skipped = [], []
    for root, dirs, _ in os.walk(nm, topdown=True):
        keep = []
        for d in dirs:
            p = os.path.join(root, d)
            if os.path.islink(p):
                continue
            reason = classify(d, target)
            if reason is None:
                keep.append(d)
                continue
            files, texty, native, own_elf, size = scan(p)
            rel = os.path.relpath(p, nm)
            if texty or os.path.exists(os.path.join(p, "package.json")) or native == 0 or own_elf:
                skipped.append({"path": rel, "reason": reason,
                                "why_kept": "has JS/JSON/package.json" if texty else
                                ("no native binary" if native == 0 else "has an ELF for this machine")})
                keep.append(d)
                continue
            shutil.rmtree(p)
            removed.append({"path": rel, "reason": reason, "files": files, "bytes": size})
        dirs[:] = keep
    total = sum(r["bytes"] for r in removed)
    report = {"target": target, "removed": removed, "removedBytes": total,
              "removedFiles": sum(r["files"] for r in removed), "keptCandidates": skipped}
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"pruned {len(removed)} directories, {report['removedFiles']} files, {total} bytes ({total / 1048576:.1f} MiB)")
    for r in removed:
        print(f"  removed {r['path']}  [{r['reason']}]  {r['bytes']} bytes")
    for s in skipped:
        print(f"  kept    {s['path']}  [{s['reason']}; {s['why_kept']}]")


TARGET_MACHINE = None
if __name__ == "__main__":
    main()
