#!/usr/bin/env python3
"""Share one copy of every package that npm installed several times, byte for byte.

npm nests a private copy of a dependency under every package that pins a version
it cannot share. In @deepseek-ai/dsh 57 packages each carry their own zod 4.4.3: 74% of
the modules the harness loads at start, and under proot every file costs system calls.

A group is deduplicated only when ALL of these hold:
  * the copies have the same directory name, the same package.json name and the
    same version;
  * their whole directory trees are identical: same names, same file contents
    (SHA-256), same exec bits, same symlinks (a symlink that points outside its
    package is not accepted);
  * every dependency a copy declares (dependencies, optionalDependencies,
    peerDependencies) resolves, as Node resolves it, to the same package content
    from the copy's own place and from the place of the shared copy.
    So moving a copy never changes which version any package gets.

Copies that fail a rule stay as they are. Each accepted copy is replaced by a relative
symlink to the shared copy. Node follows symlinks to the real path, so every user
gets the same module instance. If one copy sits at the top level of node_modules,
it is the shared copy; otherwise the shared copy is moved to
node_modules/.dsh-shared/<name>@<version>.

Usage: dedupe-modules.py <node_modules> <report.json> [--dry-run]
"""
import hashlib
import json
import os
import shutil
import stat
import sys

STORE = ".dsh-shared"
MAX_PASSES = 6


def read_json(path):
    try:
        with open(path, "rb") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def is_real_dir(p):
    return os.path.isdir(p) and not os.path.islink(p)


def package_dirs(nm):
    """Yield (location_name, path) for every package directory directly in this node_modules."""
    try:
        names = sorted(os.listdir(nm))
    except OSError:
        return
    for n in names:
        if n.startswith("."):
            continue
        p = os.path.join(nm, n)
        if not is_real_dir(p):
            continue
        if n.startswith("@"):
            for m in sorted(os.listdir(p)):
                q = os.path.join(p, m)
                if is_real_dir(q) and os.path.isfile(os.path.join(q, "package.json")):
                    yield f"{n}/{m}", q
        elif os.path.isfile(os.path.join(p, "package.json")):
            yield n, p


def all_packages(nm):
    """Every package directory in the tree (real directories only; symlinks are not followed)."""
    out = []
    stack = [nm]
    store = os.path.join(nm, STORE)
    if is_real_dir(store):
        # Shared copies are not candidates themselves, but packages nested in them are.
        for n in sorted(os.listdir(store)):
            inner = os.path.join(store, n, "node_modules")
            if is_real_dir(inner):
                stack.append(inner)
    while stack:
        cur = stack.pop()
        for name, p in package_dirs(cur):
            out.append((name, p))
            inner = os.path.join(p, "node_modules")
            if is_real_dir(inner):
                stack.append(inner)
    return out


class Hasher:
    """Tree signatures. A tree is unusable (None) when it holds anything but regular
    files, directories and symlinks that stay inside the tree or are absolute."""

    def __init__(self):
        self.cheap_cache, self.full_cache = {}, {}

    def _walk(self, top):
        for d, dirs, files in os.walk(top):
            dirs.sort()
            rel_d = os.path.relpath(d, top)
            for n in sorted(dirs + files):
                p = os.path.join(d, n)
                yield os.path.normpath(os.path.join(rel_d, n)), p

    def tree(self, top, full):
        cache = self.full_cache if full else self.cheap_cache
        if top in cache:
            return cache[top]
        h = hashlib.sha256()
        ok = True
        for rel, p in self._walk(top):
            st = os.lstat(p)
            mode = st.st_mode
            if stat.S_ISLNK(mode):
                target = os.readlink(p)
                if not os.path.isabs(target):
                    inside = os.path.normpath(os.path.join(os.path.dirname(p), target))
                    if os.path.commonpath([inside, top]) != top:
                        ok = False
                        break
                h.update(f"l {rel} {target}\n".encode())
            elif stat.S_ISDIR(mode):
                h.update(f"d {rel} {mode & 0o777:o}\n".encode())
            elif stat.S_ISREG(mode):
                h.update(f"f {rel} {mode & 0o777:o} {st.st_size}\n".encode())
                if full:
                    fh = hashlib.sha256()
                    with open(p, "rb") as f:
                        for chunk in iter(lambda: f.read(1 << 20), b""):
                            fh.update(chunk)
                    h.update(fh.digest())
            else:
                ok = False
                break
        result = h.hexdigest() if ok else None
        cache[top] = result
        return result

    def forget(self):
        self.cheap_cache.clear()
        self.full_cache.clear()


def tree_stats(top):
    files = size = 0
    for d, _dirs, names in os.walk(top):
        for n in names:
            p = os.path.join(d, n)
            files += 1
            if not os.path.islink(p):
                size += os.lstat(p).st_size
    return files, size


def declared_deps(pkg_json):
    names = set()
    for key in ("dependencies", "optionalDependencies", "peerDependencies"):
        v = pkg_json.get(key)
        if isinstance(v, dict):
            names.update(v)
    return sorted(names)


def lookup(loc, dep, alias=None):
    """First existing candidate for `dep` as Node's CommonJS and ESM resolvers look
    for it from a file inside the package directory `loc`. With alias=(virtual, real)
    the package at `real` is treated as if it already sat at `virtual`."""
    cur = loc
    while True:
        if os.path.basename(cur) != "node_modules":
            base = alias[1] if alias and cur == alias[0] else cur
            cand = os.path.join(base, "node_modules", dep)
            if os.path.lexists(cand):
                return cand
        parent = os.path.dirname(cur)
        if parent == cur:
            return None
        cur = parent


def same_package(a, b, hasher):
    if a is None or b is None:
        return a is None and b is None
    ra, rb = os.path.realpath(a), os.path.realpath(b)
    if ra == rb:
        return True
    ja, jb = read_json(os.path.join(ra, "package.json")), read_json(os.path.join(rb, "package.json"))
    if not ja or not jb or ja.get("name") != jb.get("name") or ja.get("version") != jb.get("version"):
        return False
    ha, hb = hasher.tree(ra, True), hasher.tree(rb, True)
    return ha is not None and ha == hb


def deps_resolve_same(loc_a, loc_b, deps, hasher, alias_b=None):
    for d in deps:
        if not same_package(lookup(loc_a, d), lookup(loc_b, d, alias_b), hasher):
            return False, d
    return True, None


def store_name(name, version):
    return f"{name.replace('/', '+')}@{version}"


def one_pass(nm, hasher, dry_run, log, results, skipped):
    pkgs = all_packages(nm)
    groups = {}
    for loc_name, p in pkgs:
        j = read_json(os.path.join(p, "package.json"))
        if not j or not isinstance(j.get("version"), str):
            continue
        groups.setdefault((loc_name, j.get("name"), j["version"]), []).append((p, j))
    plans = []
    for key, members in sorted(groups.items()):
        if len(members) < 2:
            continue
        by_cheap = {}
        for p, j in members:
            c = hasher.tree(p, False)
            if c is not None:
                by_cheap.setdefault(c, []).append((p, j))
        for same in by_cheap.values():
            if len(same) < 2:
                continue
            by_full = {}
            for p, j in same:
                by_full.setdefault(hasher.tree(p, True), []).append((p, j))
            for full, ident in by_full.items():
                if full is not None and len(ident) >= 2:
                    plans.append((key, ident))
    if not plans:
        return 0
    plans.sort(key=lambda kp: min(p.count(os.sep) for p, _ in kp[1]))
    changed = 0
    removed_prefixes = []  # copies this pass already replaced: anything below them is gone
    for (loc_name, _pkg_name, version), ident in plans:
        paths = sorted((p for p, _ in ident), key=lambda p: (p.count(os.sep), p))
        paths = [p for p in paths if is_real_dir(p) and not any(p.startswith(r + os.sep) for r in removed_prefixes)]
        deps = declared_deps(ident[0][1])
        top = os.path.join(nm, loc_name)
        if top in paths:
            # A copy at the top level is the shared copy; it is already where Node finds it first.
            canonical, donor, alias = top, None, None
            movers = [p for p in paths if p != top]
        else:
            # The shallowest copy moves into the store and is the reference for the others.
            if len(paths) < 2:
                continue
            donor = paths[0]
            canonical = os.path.join(nm, STORE, store_name(loc_name, version))
            alias = (canonical, donor)
            movers = paths[1:]
        eligible = []
        for p in movers:
            same, dep = deps_resolve_same(p, canonical, deps, hasher, alias)
            if same:
                eligible.append(p)
            else:
                entry = {"package": f"{loc_name}@{version}", "path": os.path.relpath(p, nm),
                         "reason": f"dependency '{dep}' resolves to different content from the shared place"}
                if entry not in skipped:
                    skipped.append(entry)
        if not eligible:
            continue
        linked = eligible + ([donor] if donor else [])
        files, size = tree_stats(paths[0])
        n_saved = len(linked) - (1 if donor else 0)
        where = os.path.relpath(canonical, nm)
        log(f"  {loc_name}@{version}: {len(linked) + (0 if donor else 1)} copies -> 1 at {where}")
        if not dry_run:
            if donor:
                os.makedirs(os.path.dirname(canonical), exist_ok=True)
                os.rename(donor, canonical)
                os.symlink(os.path.relpath(canonical, os.path.dirname(donor)), donor)
                removed_prefixes.append(donor)
            for p in eligible:
                shutil.rmtree(p)
                os.symlink(os.path.relpath(canonical, os.path.dirname(p)), p)
                removed_prefixes.append(p)
            hasher.forget()
            for p in linked:
                if os.path.realpath(p) != os.path.realpath(canonical):
                    raise SystemExit(f"FAIL: {p} does not resolve to {canonical}")
                jj = read_json(os.path.join(p, "package.json"))
                if not jj or jj.get("version") != version:
                    raise SystemExit(f"FAIL: {p} reads a different package.json after dedupe")
        results.append({"package": loc_name, "version": version, "copiesBefore": len(linked) + (0 if donor else 1),
                        "shared": where, "linked": len(linked), "filesPerCopy": files, "bytesPerCopy": size,
                        "filesSaved": files * n_saved, "bytesSaved": size * n_saved})
        changed += 1
    return changed


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry_run = "--dry-run" in sys.argv
    nm, report_path = os.path.abspath(args[0]), args[1]
    log = print
    hasher = Hasher()
    results, skipped = [], []
    before_files, before_bytes = tree_stats(nm)
    log(f"dedupe: {nm} holds {before_files} files, {before_bytes} bytes")
    for n in range(1, MAX_PASSES + 1):
        log(f"pass {n}")
        hasher.forget()
        if not one_pass(nm, hasher, dry_run, log, results, skipped):
            break
    after_files, after_bytes = tree_stats(nm)
    # Without a store move there is nothing physically removed in a dry run.
    saved_files = sum(r["filesSaved"] for r in results)
    saved_bytes = sum(r["bytesSaved"] for r in results)
    report = {"nodeModules": nm, "dryRun": dry_run, "groups": results, "skippedCopies": skipped,
              "linkedCopies": sum(r["linked"] for r in results),
              "filesBefore": before_files, "bytesBefore": before_bytes,
              "filesAfter": after_files, "bytesAfter": after_bytes,
              "filesSaved": saved_files, "bytesSaved": saved_bytes}
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)
    for r in sorted(results, key=lambda r: -r["bytesSaved"]):
        log(f"deduped {r['package']}@{r['version']}: {r['linked']} links to {r['shared']}, "
            f"saved {r['filesSaved']} files, {r['bytesSaved']} bytes")
    for s in skipped:
        log(f"kept    {s['package']} at {s['path']}: {s['reason']}")
    log(f"dedupe total: {report['linkedCopies']} copies became symlinks; files {before_files} -> {after_files}; "
        f"bytes {before_bytes} -> {after_bytes} ({saved_bytes / 1048576:.1f} MiB saved)")


if __name__ == "__main__":
    main()
