#!/usr/bin/env python3
"""Collects the CI artifacts into one release directory and writes manifest.json
and the release notes. Signing and SHA256SUMS.txt happen afterwards (sign-manifest.sh).

Usage: assemble-release.py --artifacts DIR --out DIR --release-id ID --min-app-version V
                           --repo OWNER/NAME --key-id HEX [--sequence N] [--previous-manifest FILE]

With --previous-manifest (the manifest.json of the previous published release) the assembler also
checks that no layer id was reused for different content, keeps `sequence` above the previous one,
writes the optional manifest field `previous`, and adds what changed and the update download sizes
to the release notes.
"""
import argparse
import datetime
import hashlib
import json
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
ABIS = ["arm64-v8a", "x86_64"]
HARNESS_PATHS = ["/opt/dsh", "/usr/local/bin/dsh"]
ID_HASH_LEN = 12
# The permission presets of /opt/dsh/mobile/android.patch.yml, in the order the harness reports them.
PRESET_IDS = ["danger-full-access", "ask-commands"]


def check_against_previous(archs, prev_path):
    """Fails if a layer keeps the id of the same layer in the previous release while its SHA-256 differs."""
    if not prev_path or not os.path.exists(prev_path):
        print("no previous manifest given: layer id check skipped")
        return
    prev = json.load(open(prev_path))
    bad = []
    for abi, arch in archs.items():
        old = {l["name"]: l for l in prev.get("archs", {}).get(abi, {}).get("layers", [])}
        for l in arch["layers"]:
            o = old.get(l["name"])
            if o is None:
                continue
            same_id, same_hash = o["id"] == l["id"], o["sha256"] == l["sha256"]
            print(f"{abi} {l['name']}: previous id {o['id']}, new id {l['id']}, "
                  f"{'identical archive' if same_hash else 'archive changed'}")
            if same_id and not same_hash:
                bad.append(f"{abi} {l['name']}: id {l['id']} unchanged but sha256 {o['sha256']} -> {l['sha256']}")
    if bad:
        raise SystemExit("layer id reused for different content:\n  " + "\n  ".join(bad))


def env_file(path):
    vals = {}
    for line in open(path):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            vals[k] = v
    return vals


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def asset(path, out_dir, **extra):
    shutil.copy2(path, os.path.join(out_dir, os.path.basename(path)))
    d = {"file": os.path.basename(path), "size": os.path.getsize(path), "sha256": sha256(path)}
    d.update(extra)
    return d


def mib(n):
    return f"{n / 1048576:.1f} MiB"


def same_layer(old, new):
    """A layer counts as installed only if both id and sha256 match (see README, "Layers and updates")."""
    return old is not None and old["id"] == new["id"] and old["sha256"] == new["sha256"]


def change_notes(prev, manifest, archs):
    """The "what changed" and "download sizes" parts of the release notes, from the previous manifest."""
    cur = manifest
    lines = []
    if prev is None:
        lines += ["## What changed", "",
                  "This is the first release in this repository, so there is nothing to compare with.", ""]
    else:
        pid = prev["releaseId"]
        h0, h1 = prev["harness"]["version"], cur["harness"]["version"]
        n0, n1 = prev["node"]["version"], cur["node"]["version"]
        lines += [f"## What changed since `{pid}`", ""]
        lines.append(f"- DeepSeek Harness: {h0} to {h1}." if h0 != h1
                     else f"- DeepSeek Harness: stays at {h1}. This release is a rebuild, not a new harness version.")
        lines.append(f"- Node.js: {n0} to {n1}." if n0 != n1 else f"- Node.js: unchanged at {n1}.")
        base_changed = {abi: not same_layer(next((l for l in prev.get("archs", {}).get(abi, {}).get("layers", [])
                                                  if l["name"] == "base"), None),
                                            next(l for l in archs[abi]["layers"] if l["name"] == "base"))
                        for abi in ABIS}
        if any(base_changed.values()):
            why = []
            if n0 != n1:
                why.append(f"Node.js {n0} to {n1}")
            s0, s1 = prev["debian"]["snapshot"], cur["debian"]["snapshot"]
            if s0 != s1:
                why.append(f"Debian snapshot {s0} to {s1}")
            lines.append("- Base layer (Debian and Node.js): changed" + (f" ({', '.join(why)})." if why else
                         " (rebuilt with the same versions, so the archive bytes differ)."))
        else:
            lines.append("- Base layer (Debian and Node.js): unchanged. Apps that already have it do not download it again.")
        p0, p1 = prev["proot"]["commit"], cur["proot"]["commit"]
        lines.append(f"- proot: {p0[:12]} to {p1[:12]}." if p0 != p1 else f"- proot: unchanged ({p1[:12]}).")
        lines += [f"- Rollback: the manifest's `previous` field points at `{pid}` (harness {h0}). "
                  "An app may install it only when the user asks for it.", ""]
    lines += ["## Download sizes", "",
              "What the app downloads (the proot files ship inside the app itself).", ""]
    if prev is None:
        lines += ["| Architecture | Base layer | Harness layer | First install |", "|---|---|---|---|"]
    else:
        lines += [f"| Architecture | Base layer | Harness layer | First install | Update from `{prev['releaseId']}` |",
                  "|---|---|---|---|---|"]
    for abi in ABIS:
        by = {l["name"]: l for l in archs[abi]["layers"]}
        total = by["base"]["size"] + by["harness"]["size"]
        row = f"| {abi} | {mib(by['base']['size'])} | {mib(by['harness']['size'])} | {mib(total)} |"
        if prev is not None:
            old = {l["name"]: l for l in prev.get("archs", {}).get(abi, {}).get("layers", [])}
            upd = sum(l["size"] for l in archs[abi]["layers"] if not same_layer(old.get(l["name"]), l))
            row += f" {mib(upd)} |" if upd else " nothing |"
        lines.append(row)
    lines.append("")
    return lines


def main():
    ap = argparse.ArgumentParser()
    for opt in ("--artifacts", "--out", "--release-id", "--min-app-version", "--repo", "--key-id"):
        ap.add_argument(opt, required=True)
    ap.add_argument("--sequence", type=int)
    ap.add_argument("--previous-manifest", help="manifest.json of the previous published release (id reuse check)")
    a = ap.parse_args()
    pins = env_file(os.path.join(HERE, "versions.env"))
    os.makedirs(a.out, exist_ok=True)
    art = a.artifacts
    now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)

    pa = os.path.join(art, "proot-android")
    pinfo = json.load(open(os.path.join(pa, "proot-android.json")))
    sources = [asset(os.path.join(pa, f), a.out) for f in sorted(os.listdir(pa)) if f.endswith(".tar.gz")]

    archs, layer_docs, smoke = {}, {}, {}
    for abi in ABIS:
        d = os.path.join(art, f"layers-{abi}")
        doc = json.load(open(os.path.join(d, f"layers-{abi}.json")))
        layer_docs[abi] = doc
        smoke[abi] = json.load(open(os.path.join(d, f"smoke-{abi}.json")))
        # The smoke test already stops the build on a failure; this makes the release itself refuse too.
        m = smoke[abi]["modulePack"]
        assert m["responsesIdenticalOnVsOff"] is True and m["outsideTreeModuleFromDisk"] is True, f"{abi}: module pack checks"
        assert m["degradedCasesPassed"] >= 9 and m["callsOk"] >= 20, f"{abi}: module pack checks"
        assert m["buildId"] == doc["modulePack"]["buildId"], f"{abi}: smoke test ran another pack"
        sp = smoke[abi]["shellPermissions"]
        assert sp["catalog"]["ids"] == PRESET_IDS and sp["catalog"]["defaultPreset"] == PRESET_IDS[0], \
            f"{abi}: the harness reports presets {sp['catalog']}, not {PRESET_IDS}"
        assert sp["harnessStarts"] >= 9 and sp["failClosedVariants"] >= 5 and sp["scenariosPassed"] >= 30, f"{abi}: shell permission checks"
        proot = [
            asset(os.path.join(pa, f"android-{abi}-libproot.so"), a.out, installAs="libproot.so"),
            asset(os.path.join(pa, f"android-{abi}-libproot-loader.so"), a.out, installAs="libproot-loader.so"),
        ]
        layers = []
        for name in ("base", "harness"):
            l = doc[name]
            entry = asset(os.path.join(d, l["file"]), a.out)
            assert entry["sha256"] == l["sha256"], f"{l['file']} changed between build and release"
            # The id changes whenever the archive changes: readable part plus the first 12 hex digits
            # of the archive SHA-256. The same bytes always give the same id.
            entry.update({"name": name, "id": f"{l['id']}-{entry['sha256'][:ID_HASH_LEN]}", "compression": "zstd", "zstdWindowLog": 27,
                          "format": "tar (GNU)", "unpackedSize": l["unpackedSize"], "entries": l["entries"],
                          "owns": ["/"] if name == "base" else HARNESS_PATHS})
            if name == "base":
                entry["excludes"] = HARNESS_PATHS
            else:
                # Optional extra fields (unknown fields must be ignored by the app).
                mp, dd = doc["modulePack"], doc["dedupe"]
                entry["modulePack"] = {"buildId": mp["buildId"], "packBytes": mp["packBytes"], "modules": mp["modules"]}
                entry["dedupe"] = {"copiesLinked": dd["linkedCopies"], "filesSaved": dd["filesSaved"], "bytesSaved": dd["bytesSaved"]}
            layers.append(entry)
        archs[abi] = {"debianArch": doc["debianArch"], "proot": proot, "layers": layers}
        for extra in (f"debian-packages-{abi}.txt",):
            shutil.copy2(os.path.join(d, extra), os.path.join(a.out, extra))

    harness_version = layer_docs[ABIS[0]]["harnessVersion"]
    node_version = layer_docs[ABIS[0]]["nodeVersion"]
    snapshot = layer_docs[ABIS[0]]["debianSnapshot"]
    for abi in ABIS:
        for k, v in (("harnessVersion", harness_version), ("nodeVersion", node_version), ("debianSnapshot", snapshot)):
            assert layer_docs[abi][k] == v, f"{abi} has a different {k}"

    # What the running harness reported for its presets (both architectures must agree); this is what
    # the optional manifest field `runtime.permissions` describes.
    cat = smoke[ABIS[0]]["shellPermissions"]["catalog"]
    for abi in ABIS:
        assert smoke[abi]["shellPermissions"]["catalog"] == cat, f"{abi} reports other permission presets"
    names = dict(zip(cat["ids"], cat["names"]))
    permissions = {
        "version": 1,
        "description": "Two permission presets for the built-in harness, because no kernel sandbox can run in an Android app. "
                       "See the README, 'Shell commands and permissions on Android'.",
        "patch": "/opt/dsh/mobile/android.patch.yml",
        "catalogMethod": "permissionPresets/catalog",
        "presets": [
            {"id": "danger-full-access", "name": names["danger-full-access"], "envValue": "full", "approval": "never",
             "asksBeforeCommands": False},
            {"id": "ask-commands", "name": names["ask-commands"], "envValue": "ask", "approval": "ask",
             "asksBeforeCommands": True},
        ],
        "defaultEnv": "DSH_RUNTIME_DEFAULT_PERMISSION",
        "defaultEnvValues": ["full", "ask"],
        "defaultWhenUnset": "danger-full-access",
        "defaultForUnknownValue": "ask-commands",
        "disableEnv": "DSH_RUNTIME_MOBILE_PATCH",
        "disableValue": "0",
        "approvalChannel": "approval/request, answered with allowed-once or rejected over the harness client protocol",
    }

    check_against_previous(archs, a.previous_manifest)
    prev = json.load(open(a.previous_manifest)) if a.previous_manifest and os.path.exists(a.previous_manifest) else None

    # The sequence must keep increasing, also for several releases within one second of the
    # clock (or a clock that is behind): never at or below the previous release.
    sequence = a.sequence or int(now.timestamp())
    if prev is not None and sequence <= prev["sequence"]:
        if a.sequence:
            raise SystemExit(f"--sequence {a.sequence} is not above the previous release's {prev['sequence']}")
        sequence = prev["sequence"] + 1

    manifest = {
        "schemaVersion": 1,
        "releaseId": a.release_id,
        "sequence": sequence,
        "createdAt": now.isoformat().replace("+00:00", "Z"),
        "minAppVersion": a.min_app_version,
        "signing": {"algorithm": "Ed25519", "keyId": a.key_id, "signatureFile": "manifest.json.sig"},
        "assetBaseUrl": f"https://github.com/{a.repo}/releases/download/{a.release_id}/",
        "harness": {"package": "@deepseek-ai/dsh", "version": harness_version, "license": "MIT"},
        "node": {"version": node_version, "home": "/opt/node"},
        "debian": {"suite": pins["DEBIAN_SUITE"], "snapshot": snapshot,
                   "baseId": layer_docs[ABIS[0]]["baseId"]},
        "proot": {"repo": pins["PROOT_REPO"], "commit": pins["PROOT_COMMIT"], "version": pins["PROOT_VERSION"],
                  "talloc": pins["TALLOC_VERSION"], "ndk": pins["NDK_VERSION"], "androidApi": int(pins["ANDROID_API"]),
                  "license": "GPL-2.0-or-later (talloc: LGPL-3.0-or-later)", "sources": sources},
        "runtime": {
            "entrypoint": "/usr/local/bin/dsh",
            "readinessPrefix": "dsh web: http://127.0.0.1:",
            "fakeProc": [{"source": f"/opt/dsh-runtime/proc/{n}", "target": f"/proc/{n}"}
                         for n in ("stat", "loadavg", "uptime")],
            "resolvConf": "/etc/resolv.conf",
            # Optional. The app needs to do nothing: /usr/local/bin/dsh turns the pack on by itself.
            "startup": {
                "modulePack": {
                    "enabledByDefault": True,
                    "disableEnv": "DSH_RUNTIME_MODULE_PACK",
                    "disableValue": "0",
                    "directory": "/opt/dsh/runtime-pack",
                    "buildIdFile": "/opt/dsh/build-id",
                    "mechanism": "node --import preload that uses module.registerHooks; falls back to normal Node.js on any miss",
                    "validatedNodeVersion": node_version,
                },
                "dedupe": "identical nested packages (same name, version and content) are symlinks to one shared copy",
            },
            # Optional. Present when this harness layer supports the two permission presets and the
            # environment switches; an older runtime has no such field and no presets.
            "permissions": permissions,
        },
        "archs": archs,
    }
    if prev is not None:
        # Optional. Lets an app offer "go back to the previous version": fetch manifestUrl,
        # check its signature (manifest.json.sig next to it) with the same pinned key, and
        # install it only on an explicit user action. See the README.
        manifest["previous"] = {
            "releaseId": prev["releaseId"],
            "harnessVersion": prev["harness"]["version"],
            "sequence": prev["sequence"],
            "manifestUrl": f"https://github.com/{a.repo}/releases/download/{prev['releaseId']}/manifest.json",
        }
    with open(os.path.join(a.out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    # Release notes.
    lines = [
        f"DSH Mobile runtime bundle `{a.release_id}`.",
        "",
    ] + change_notes(prev, manifest, archs) + [
        "## Versions",
        "",
        "| Component | Version |",
        "|---|---|",
        f"| DeepSeek Harness (`@deepseek-ai/dsh`) | {harness_version} |",
        f"| Node.js | {node_version} |",
        f"| Debian | {pins['DEBIAN_SUITE']}, snapshot {snapshot} |",
        f"| proot | {pins['PROOT_VERSION']} ([`{pins['PROOT_COMMIT'][:12]}`]({pins['PROOT_REPO']}/tree/{pins['PROOT_COMMIT']})), talloc {pins['TALLOC_VERSION']} static, NDK {pins['NDK_VERSION']} |",
        f"| Minimum app version | {a.min_app_version} |",
        "",
        "## Layers and checks",
        "",
        "| Architecture | Layer | File | Compressed | Unpacked | Entries |",
        "|---|---|---|---|---|---|",
    ]
    for abi in ABIS:
        for l in archs[abi]["layers"]:
            lines.append(f"| {abi} | {l['name']} | `{l['file']}` | {mib(l['size'])} | {mib(l['unpackedSize'])} | {l['entries']:,} |")
    lines += ["", "| Architecture | proot | loader | Smoke test: first start to ready | Pruned |",
              "|---|---|---|---|---|"]
    for abi in ABIS:
        p, s, pr = archs[abi]["proot"], smoke[abi], layer_docs[abi]["prune"]
        lines.append(f"| {abi} | {p[0]['size']:,} B | {p[1]['size']:,} B | {s['firstStartToReadySeconds']} s "
                     f"| {pr['removedFiles']} files, {mib(pr['removedBytes'])} |")
    lines += ["", "Start-up work in the harness layer (nothing for the app to do):", "",
              "| Architecture | Module pack | Start to ready, pack on (median of 3) | pack off | Path syscalls on / off | Shared nested copies |",
              "|---|---|---|---|---|---|"]
    for abi in ABIS:
        mp, dd, s = layer_docs[abi]["modulePack"], layer_docs[abi]["dedupe"], smoke[abi]["modulePack"]
        sc_on, sc_off = s["packOn"]["pathSyscalls"], s["packOff"]["pathSyscalls"]
        sc = f"{sc_on:,} / {sc_off:,}" if sc_on and sc_off else "not measured"
        lines.append(f"| {abi} | {mib(mp['packBytes'])}, {mp['modules']:,} modules | {s['packOn']['medianSeconds']} s "
                     f"| {s['packOff']['medianSeconds']} s | {sc} "
                     f"| {dd['linkedCopies']} links, {dd['filesSaved']:,} files, {mib(dd['bytesSaved'])} saved |")
    lines += ["", "Shell commands and permissions (nothing for the app to do except choose; see the README):", "",
              "| Architecture | Harness starts | Scenarios passed | Fail-closed variants | Presets, as the running harness reports them |",
              "|---|---|---|---|---|"]
    for abi in ABIS:
        sp = smoke[abi]["shellPermissions"]
        presets = ", ".join(f"`{i}` ({n})" for i, n in zip(sp["catalog"]["ids"], sp["catalog"]["names"]))
        lines.append(f"| {abi} | {sp['harnessStarts']} | {sp['scenariosPassed']} | {sp['failClosedVariants']} | {presets} |")
    lines += ["",
              "`DSH_RUNTIME_DEFAULT_PERMISSION` (`full` or `ask`, default `full`) picks the preset a new session starts with, and "
              "`DSH_RUNTIME_MOBILE_PATCH=0` switches the presets off again (upstream behaviour: every shell command is refused "
              "with `SANDBOX_UNAVAILABLE`). The manifest describes both in the optional field `runtime.permissions`.",
              "",
              "The module pack is on by default and `DSH_RUNTIME_MODULE_PACK=0` turns it off (see the README). "
              "Smoke test times are from the GitHub Actions runner under a Linux build of the same proot "
              "commit, not from a phone.",
              "",
              f"ELF alignment: arm64 {layer_docs['arm64-v8a']['alignment']['aligned']} of "
              f"{layer_docs['arm64-v8a']['alignment']['checked']} files at 16 KB or more (required). "
              f"x86_64 {layer_docs['x86_64']['alignment']['aligned']} of {layer_docs['x86_64']['alignment']['checked']} "
              "(reported only: Debian builds x86_64 with 4 KB pages). Both proot builds: "
              f"{pinfo['alignmentSummary']}.",
              "",
              "Verify `manifest.json` with `manifest.json.sig` (Ed25519) and the public key in the repository "
              "README before trusting any hash in it. `SHA256SUMS.txt` covers every asset."]
    with open(os.path.join(a.out, "release-notes.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print(json.dumps({"releaseId": a.release_id, "harness": harness_version, "node": node_version}))


if __name__ == "__main__":
    main()
