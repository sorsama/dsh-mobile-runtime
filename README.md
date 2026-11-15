# DSH Mobile runtime

This repository builds the runtime that lets DSH Mobile run the DeepSeek Harness
(`@deepseek-ai/dsh`) on the phone itself. A release holds, for `arm64-v8a` and `x86_64`:

- **proot** and its loader, built for Android from source. These go into the app's
  `jniLibs` as `libproot.so` and `libproot-loader.so`.
- A **base layer**: a minimal Debian trixie (glibc) root file system with Node.js 24 LTS.
- A **harness layer**: the DeepSeek Harness installed under `/opt/dsh`.

The app downloads the layers once, checks them against a signed manifest, unpacks them
into its private storage and starts the harness inside proot. Everything is built by
GitHub Actions in this repository and published only as GitHub release assets.

## Release assets

| Asset | What it is |
|---|---|
| `manifest.json` | Describes the release: versions, files, sizes, SHA-256 hashes. |
| `manifest.json.sig` | Ed25519 signature of `manifest.json`, base64. |
| `SHA256SUMS.txt` | `sha256sum` output for every other asset. |
| `dsh-runtime-base-<abi>.tar.zst` | Base layer: Debian, Node.js, runtime support files. |
| `dsh-runtime-harness-<abi>.tar.zst` | Harness layer: `/opt/dsh` and `/usr/local/bin/dsh`. |
| `android-<abi>-libproot.so` | proot for Android. Install as `jniLibs/<abi>/libproot.so`. |
| `android-<abi>-libproot-loader.so` | proot's loader. Install as `jniLibs/<abi>/libproot-loader.so`. |
| `proot-source-<commit>.tar.gz` | The exact proot source the binaries were built from (GPL-2.0). |
| `talloc-source-<version>.tar.gz` | The exact talloc source linked into proot (LGPL-3.0). |
| `debian-packages-<abi>.txt` | Every Debian package in the base layer, with its version. |

`<abi>` is `arm64-v8a` or `x86_64`, the Android ABI names.

The latest release is always at
`https://github.com/sorsama/dsh-mobile-runtime/releases/latest/download/manifest.json`.
Asset URLs are `assetBaseUrl` from the manifest plus the file name.

## What is inside the unpacked root file system

```
/                         Debian trixie, minbase variant, merged /usr
  bin, usr, etc, var ...  bash, coreutils, ca-certificates, curl, git, openssh-client,
                          less, procps, tar, gzip, xz-utils, zstd, ripgrep, apt
  etc/resolv.conf         placeholder (8.8.8.8, 1.1.1.1); the app should rewrite it
  etc/hosts               localhost for IPv4 and IPv6
  tmp/                    mode 1777, also bound over /dev/shm
  root/                   HOME of the (fake) root user; root/work is the default working dir
  opt/node/               official Node.js build (include/ and share/ removed)
  usr/local/bin/          node, npm, npx, corepack (symlinks into /opt/node/bin)
  opt/dsh-runtime/
    base.json             {"baseId", "abi", "debianSuite", "debianSnapshot", "nodeVersion"}
    proc/stat             fake /proc files (8 CPUs), see "Running"
    proc/loadavg
    proc/uptime
  opt/dsh/                harness layer: npm project with node_modules
    layer.json            {"harnessPackage", "harnessVersion", "releaseId", "abi", "baseId"}
    build-id              identity of this /opt/dsh build; the module pack is valid only for it
    runtime-pack/         module pack (pack.bin) and its preload, see "Startup: shared packages and the module pack"
    mobile/               the Android permission presets: android.patch.yml and permission.mjs, see
                          "Shell commands and permissions on Android"
  usr/local/bin/dsh       harness layer: launcher script, exec's node on the harness
```

Docs and man pages are left out to save space; every package's `copyright` file is kept
under `/usr/share/doc`. Apt points at `deb.debian.org`, so `apt-get update && apt-get install`
works inside the runtime.

## Layers and updates

The two layers are separate files so a harness update does not download Debian and Node again.

- **base** owns the whole tree except the harness paths (`excludes`: `/opt/dsh`,
  `/usr/local/bin/dsh`).
- **harness** owns `/opt/dsh` and `/usr/local/bin/dsh`.

A layer `id` is a readable part, a dash, and the first 12 hex digits of the SHA-256 of the
layer archive (the same value as `sha256`, truncated):

- base: `trixie-<snapshot>-node<version>-r<revision>-<hash12>`, for example
  `trixie-20261110T000000Z-node24.22.3-r1-0123456789ab`
- harness: `dsh-<harness version>-<hash12>`, for example `dsh-0.2.2-rc.1-0123456789ab`

So the id changes whenever the archive changes, even when the readable part stays the same
(for example a rebuilt harness layer with the same npm version). Two builds that produce
byte-identical archives get the same id, so an unchanged base layer is not downloaded again.
`debian.baseId` is only the readable part of the base id, without the hash.

Update rule for the app: a layer counts as already installed only if **both** its `id` and its
`sha256` equal the values of the installed layer. If either differs, download it. (Releases
before `2026.11.14-3` used only the readable part as the id and reused it for changed
content, so never trust the id alone.) If only the harness changed, delete `/opt/dsh` and `/usr/local/bin/dsh` and unpack the new
harness layer over the existing tree. If the base changed, unpack the base into a new staging
directory, unpack the harness on top, then swap directories. User data should not live inside
the layers' paths (the harness keeps its state under `/root`; a base update replaces `/root`
unless the app moves it across).

## How updates reach the app

New harness versions reach phones without an app update and without anyone cutting a release
by hand. The GitHub Actions workflow **Build runtime** does it.

**The schedule.** The workflow runs every 6 hours (cron `17 */6 * * *`, UTC) and on demand. The
first job asks npm for the dist-tag `latest` of `@deepseek-ai/dsh` and compares it with
`harness.version` in the manifest of this repository's latest release (after checking that
manifest's signature). If they are equal, the run ends after that one short job and builds
nothing. If npm has a different version, the workflow builds that exact version and publishes it
as a new release. The new release keeps the previous release's `minAppVersion` unless you
dispatch by hand and set another one.

**Release ids and sequence.** An automatic release id is the UTC date plus the next free number
of that day, for example `2026.11.15-2`. The number comes from the existing release tags, so ids
are unique, and they order by date and then by number (compare the number as a number: `-10` comes
after `-9`). `sequence` is the build time in Unix seconds, and never lower than the previous
release's `sequence` plus one, so it always increases, even for two releases in one second.

**One release per harness version.** At most one run builds at a time (a single concurrency
group), so two runs never build the same version together. If any release already carries the
harness version npm reports (for example because npm moved `latest` back to an older version),
the scheduled run does not publish a second one. Dispatch by hand with `rebuild` to force it.

**The gates.** Nothing is published unless every one of these passes; they are the same checks
that were always part of the build (see "How the build works"):

- proot builds for both ABIs, with 16 KB ELF alignment checked;
- the layer build, including the proof that the harness install touched only the harness paths
  and that sharing nested packages changed no dependency resolution;
- ELF alignment of the arm64 bundle;
- the smoke test under proot for both ABIs: the module pack on and off give the same JSON, all
  degraded-pack cases still start, a module outside `/opt/dsh` is read from disk, and the shell
  permission checks pass (a scripted fake model makes the real harness run its real tools; see
  "Shell commands and permissions on Android");
- the interface check of the Android permission patch against the harness version being built: if a
  new harness version changed something the patch relies on, the build stops with a message that
  names it, instead of publishing presets that silently do not work;
- the manifest signature, checked against the public key committed here;
- the previous release's manifest, which must verify against the same key, and the layer id check
  against it (a layer id is never reused for different content);
- after publishing, the release is downloaded again without a token and verified: the manifest
  signature, every hash in `SHA256SUMS.txt`, and the `previous` pointer (see below). A release that
  fails this is deleted again, with its tag.

**Node.js.** The harness declares the Node.js it needs in `engines.node`. If the Node.js in
`scripts/versions.env` (or in the previous release, when that is newer) meets it, the base layer
stays as it is. If not, the base layer is rebuilt with the newest Node.js 24.x release that does
(`scripts/node-engine.mjs`). If the harness needs a Node.js that no 24.x release meets, the build
fails before anything is built, with a message that says so: a new Node.js major is a deliberate
change (bump `NODE_VERSION`, check the module pack, run the workflow by hand). If a bundle fails
to start in the smoke test for any reason, the log ends with a line that says whether the
harness's `engines.node` is met by the bundled Node.js.

**What happens on failure.** A failed build publishes nothing, because the release job only
runs when every build job and gate before it passed. A scheduled run that wanted to build and
failed opens a GitHub issue titled `Automatic runtime build failed for @deepseek-ai/dsh <version>`
(label `runtime-auto-release`) with a link to the run and the failed jobs. If an open issue with
that title already exists, the run adds a comment to it instead of opening another one. When a
release with that harness version is published later, the run comments and closes the issue.
The next scheduled run tries again. A manual run opens an issue only if you tick
`report_failures`.

**Rebuilding by hand.**

```sh
# a rebuild of the version npm calls latest (new release id, same harness)
gh workflow run build-runtime.yml --repo sorsama/dsh-mobile-runtime -f rebuild=true
# a specific harness version
gh workflow run build-runtime.yml --repo sorsama/dsh-mobile-runtime -f harness_version=0.2.2-rc.1 -f rebuild=true
# everything except publishing
gh workflow run build-runtime.yml --repo sorsama/dsh-mobile-runtime -f dry_run=true
```

**Stopping automatic releases.** Set the repository variable `RUNTIME_AUTO_RELEASE` to `off`:

```sh
gh variable set RUNTIME_AUTO_RELEASE --body off --repo sorsama/dsh-mobile-runtime
gh variable delete RUNTIME_AUTO_RELEASE --repo sorsama/dsh-mobile-runtime   # back on
```

While it is `off` the scheduled run starts, says so in its summary and ends; manual runs still
work. `gh workflow disable build-runtime.yml` stops the schedule too, but also stops manual
runs. GitHub itself pauses scheduled workflows of a public repository after 60 days without
repository activity; if that happens, enable the workflow again in the Actions tab.

**Going back (rollback).** Every manifest after the first can carry the optional field
`previous`, which points at the release before it:

```json
"previous": {
  "releaseId": "2026.11.14-3",
  "harnessVersion": "0.2.2-rc.1",
  "sequence": 1794682933,
  "manifestUrl": "https://github.com/sorsama/dsh-mobile-runtime/releases/download/2026.11.14-3/manifest.json"
}
```

To offer "go back to the previous version", the app fetches `manifestUrl` and the signature next
to it (`manifest.json.sig` in the same directory), verifies it with the same pinned key, and
then follows the normal install steps for that manifest. It does this only when the user asks.
A lower `sequence` is acceptable only for this user-chosen rollback. An automatic update must
never install a manifest whose `sequence` is lower than the installed one. The `previous`
manifest may itself have a `previous`, so the app can walk back further; a rebuild has the same
harness version as the release before it, so look for the first one with another
`harnessVersion` if that is what the user wants. After a rollback the installed `sequence` is
the old, lower one. The app should remember that the user chose it, and skip the release it
rolled back from; it may update automatically again once a release newer than that one
appears.

## Manifest schema (version 1)

`manifest.json` is UTF-8 JSON. Unknown fields must be ignored.

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | int | `1`. Refuse a manifest with a higher major schema you do not know. |
| `releaseId` | string | The release tag, for example `2026.11.14-1`. |
| `sequence` | int | Increases with every release (Unix time of the build, and always above the previous release's). An automatic update never installs a manifest whose `sequence` is lower than the installed one. The only exception is a rollback the user asked for (see `previous`). |
| `createdAt` | string | ISO 8601 UTC time of the build. |
| `minAppVersion` | string | Lowest DSH Mobile `versionName` (semver) that may install this release. |
| `signing.algorithm` | string | `Ed25519`. |
| `signing.keyId` | string | First 16 hex digits of SHA-256 of the raw 32-byte public key. |
| `signing.signatureFile` | string | `manifest.json.sig`. |
| `assetBaseUrl` | string | Prefix for asset downloads, ends with `/`. |
| `harness.package`, `harness.version` | string | `@deepseek-ai/dsh` and its exact npm version. |
| `node.version`, `node.home` | string | Node.js version, and `/opt/node`. |
| `debian.suite`, `debian.snapshot` | string | `trixie`, and the snapshot.debian.org timestamp the packages came from. |
| `debian.baseId` | string | The readable part of the base layer `id`, without the hash suffix. |
| `proot.repo`, `proot.commit`, `proot.version` | string | Source of proot (`termux/proot`). |
| `proot.talloc`, `proot.ndk`, `proot.androidApi` | string, string, int | talloc version (linked statically), NDK version, API level of the build. |
| `proot.sources[]` | array of file | The source tarballs published with the release. |
| `runtime.entrypoint` | string | `/usr/local/bin/dsh`. |
| `runtime.readinessPrefix` | string | `dsh web: http://127.0.0.1:`. The harness prints this, followed by `<port>/?token=<token>`, when it is ready. |
| `runtime.fakeProc[]` | array of `{source, target}` | Files to bind over `/proc` entries (see "Running"). Paths are inside the guest. |
| `runtime.resolvConf` | string | `/etc/resolv.conf`, the file the app should rewrite with the device DNS servers. |
| `runtime.startup` | object, optional | Describes the start-up work in the harness layer. `startup.modulePack` has `enabledByDefault` (true), `disableEnv` (`DSH_RUNTIME_MODULE_PACK`), `disableValue` (`0`), `directory`, `buildIdFile`, `mechanism` and `validatedNodeVersion`. For information only: the app needs no change. |
| `runtime.permissions` | object, optional | Present when this harness layer has the two permission presets and the environment switches (see "Shell commands and permissions on Android"). An installed runtime without it has none of that. Fields: `version` (1), `patch` (the overlay file in the guest), `catalogMethod` (`permissionPresets/catalog`), `presets[]` (each `{id, name, envValue, approval, asksBeforeCommands}`; the ids and names are what the running harness reports: `danger-full-access` "Full access", `ask-commands` "Ask before commands"), `defaultEnv` (`DSH_RUNTIME_DEFAULT_PERMISSION`), `defaultEnvValues` (`["full", "ask"]`), `defaultWhenUnset` (`danger-full-access`), `defaultForUnknownValue` (`ask-commands`), `disableEnv` (`DSH_RUNTIME_MOBILE_PATCH`), `disableValue` (`0`), `approvalChannel` (free text). |
| `previous` | object, optional | The release before this one, so the app can offer "go back to the previous version". Absent in the first release. `previous.releaseId`, `previous.harnessVersion` (string), `previous.sequence` (int) and `previous.manifestUrl` (string, the URL of that release's `manifest.json`; its signature is `manifest.json.sig` in the same directory). The app fetches that manifest, verifies its signature with the same pinned key and installs it only on an explicit user action. See "How updates reach the app". |
| `archs` | object | Keyed by Android ABI (`arm64-v8a`, `x86_64`). |
| `archs.<abi>.debianArch` | string | `arm64` or `amd64`. |
| `archs.<abi>.proot[]` | array of file | The two proot binaries, each with `installAs` (`libproot.so`, `libproot-loader.so`). |
| `archs.<abi>.layers[]` | array of layer | In install order: `base`, then `harness`. |

A **file** object is `{ "file", "size", "sha256" }` plus extra fields: `file` is the asset name,
`size` the exact byte size of the download, `sha256` its lower-case hex SHA-256.

A **layer** is a file object plus:

| Field | Meaning |
|---|---|
| `name` | `base` or `harness`. |
| `id` | Identity of the layer content: readable part plus 12 hex digits of the archive SHA-256 (see "Layers and updates"). Skip a download only if both `id` and `sha256` match the installed layer. |
| `compression` | `zstd`. |
| `zstdWindowLog` | `27`: the decoder needs a 128 MiB window. Standard decoders accept this without special flags. |
| `format` | `tar (GNU)`. |
| `unpackedSize` | Sum of the sizes of all regular files in the layer, in bytes. Real disk use is higher (blocks, directories, link2symlink files); check for about 1.3 times this plus some headroom before unpacking. |
| `entries` | Number of tar entries. Use it for progress. |
| `owns` | Guest paths this layer owns (`["/"]` for base). |
| `excludes` | Base only: paths inside `owns` that belong to other layers. |
| `modulePack`, `dedupe` | Harness only, optional: `{buildId, packBytes, modules}` of the module pack and `{copiesLinked, filesSaved, bytesSaved}` of the shared nested packages. For information only. |

## Verifying a release

Public key (Ed25519), key id `20edea657d2e377a`:

```
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEARZAmCAbwfFeuxZ4JVxXsgYDS49uOycb4bnjt4DoW00w=
-----END PUBLIC KEY-----
```

Raw 32-byte public key, base64: `RZAmCAbwfFeuxZ4JVxXsgYDS49uOycb4bnjt4DoW00w=`
(also in [`keys/runtime-signing-ed25519.pub.pem`](keys/runtime-signing-ed25519.pub.pem)).

Procedure for the app:

1. Download `manifest.json` and `manifest.json.sig`. Keep the manifest as raw bytes.
2. Base64-decode the signature (ignore surrounding whitespace). It must be 64 bytes.
3. Verify the Ed25519 signature over the exact bytes of `manifest.json` with the public key
   above, compiled into the app. Stop on failure. Do not parse the JSON before this step.
   `java.security.Signature("Ed25519")` exists only from API 33; for older devices use
   Bouncy Castle (`Ed25519Signer`) or Tink (`Ed25519Verify`) with the raw key.
4. Parse the JSON. Check `schemaVersion`, `minAppVersion` against the app's version, that
   `sequence` is not lower than the installed one, and that `archs` has the device's ABI
   (`Build.SUPPORTED_ABIS`, first match). The `sequence` check is for automatic updates. For a
   rollback the user asked for (the manifest came from `previous.manifestUrl` of the installed
   release), a lower `sequence` is accepted; do all other checks the same way.
5. Download each needed layer from `assetBaseUrl + file`. Check the byte count against `size`
   and the SHA-256 against `sha256` before decompressing. Delete the file on any mismatch.

On a computer, with OpenSSL 3:

```sh
scripts/verify-manifest.sh manifest.json manifest.json.sig
sha256sum -c SHA256SUMS.txt
```

## Unpacking rules

Layers are GNU-format tar files compressed with zstd (`-19 --long=27`). The build checks that:

- every entry is a regular file, a directory or a symbolic link (hard links are flattened into
  regular files, there are no device nodes or FIFOs);
- names are relative, without `.` or `..` components or a leading `./`, and never repeat;
- long names use GNU `L` (long name) and `K` (long link) headers;
- owner and group are 0, every modification time is the Debian snapshot time.

An extractor in the app should:

- still reject absolute names and `..` components, and never follow a symlink while creating a
  path (create parents with `mkdir`, check that no parent is a symlink);
- create symlinks exactly as stored (`Os.symlink(target, path)`); many targets are absolute
  paths that only make sense inside the guest;
- apply file modes (keep the executable bits; setuid and setgid have no effect), and apply
  directory modes after all entries are written, since some directories are read-only;
- write into a staging directory and rename it into place only when the whole layer is done;
- check free space first (see `unpackedSize`).

## Running

proot is started from `nativeLibraryDir` (files must be named `lib*.so` and packaged with
`useLegacyPackaging`). These builds link talloc statically, so no `libtalloc.so` and no
`LD_LIBRARY_PATH` are needed. Nothing in them points at Termux paths, but proot needs two
environment variables:

```
PROOT_LOADER=<nativeLibraryDir>/libproot-loader.so     # required: the compiled-in default does not exist
PROOT_TMP_DIR=<cacheDir>/proot-tmp                     # required on Android: the default is /tmp
# PROOT_NO_SECCOMP must stay unset (slower, and it breaks git)
```

Command line (`<rootfs>` is the unpacked tree, for example `noBackupFilesDir/rootfs`):

```
<nativeLibraryDir>/libproot.so --kill-on-exit --link2symlink -0 \
  -r <rootfs> \
  -b /dev -b /proc -b /sys -b /proc/self/fd:/dev/fd -b <rootfs>/tmp:/dev/shm \
  -b <rootfs>/opt/dsh-runtime/proc/stat:/proc/stat \
  -b <rootfs>/opt/dsh-runtime/proc/loadavg:/proc/loadavg \
  -b <rootfs>/opt/dsh-runtime/proc/uptime:/proc/uptime \
  -w /root \
  /usr/bin/env -i HOME=/root USER=root LOGNAME=root \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin \
    LANG=C.UTF-8 TERM=dumb TMPDIR=/tmp \
  /bin/bash -c 'umask 022; mkdir -p /root/work && cd /root/work && exec dsh web --no-open --port 3080'
```

Notes:

- The fake `/proc` binds exist because SELinux denies apps `/proc/stat`, `/proc/loadavg` and
  `/proc/uptime`; without them `os.cpus()` is empty. The shipped `stat` lists 8 CPUs. The app
  may rewrite `opt/dsh-runtime/proc/stat` before each start with one `cpuN` line per CPU
  (`Runtime.availableProcessors()`); keep the format of the shipped file.
- Rewrite `/etc/resolv.conf` before each start from the active network's DNS servers
  (`LinkProperties.getDnsServers()`). The shipped file uses public resolvers, which some
  networks block.
- `env -i` keeps Android's environment out of the glibc programs. `umask 022` is needed
  because the app's umask is 077.
- Readiness: wait for a line that starts with `runtime.readinessPrefix` on the harness output.
  The rest of the line holds the launch token. Keep it out of logs.
- Stopping: proot ignores SIGTERM. Send SIGTERM to the guest's main process (the child of
  proot; `dsh` and `bash -c ... exec` keep it the node process), wait up to about 5 seconds,
  then SIGQUIT proot, then SIGKILL anything left. `Process.destroy()` alone does nothing.
- The app needs the `INTERNET` permission (the guest inherits the `inet` group).
- The harness starts faster with the module pack, which `/usr/local/bin/dsh` turns on by
  itself. To turn it off, for example while chasing a start-up problem, add
  `DSH_RUNTIME_MODULE_PACK=0` to the `env -i` list. See "Startup: shared packages and the
  module pack".
- `/usr/local/bin/dsh` also gives `dsh web` the Android permission presets (Full access, Ask before
  commands). `DSH_RUNTIME_DEFAULT_PERMISSION=full` or `=ask` in the `env -i` list picks the preset a
  new session starts with (default `full`), and `DSH_RUNTIME_MOBILE_PATCH=0` leaves the presets out.
  See "Shell commands and permissions on Android".

## Startup: shared packages and the module pack

Under proot every file system call costs about 70 microseconds on a PC and more on a phone,
and a plain start of the harness makes roughly 52,000 of them. Two build steps in the harness
layer remove most of that. Neither needs any change in the app.

### Shared nested packages

npm gives each package its own private copy of a dependency it cannot share. In
`@deepseek-ai/dsh` 57 packages each carry a copy of `zod` 4.4.3 (about 40,000 files and
240 MiB). `scripts/dedupe-modules.py` keeps one copy of every package that appears several
times with the same name, the same version and byte-identical content, and replaces the other
copies with relative symlinks. A group is touched only when:

- the whole directory trees are identical: names, file contents (SHA-256), exec bits, and
  symlinks (a symlink that points out of its package is not accepted);
- every dependency the copies declare (`dependencies`, `optionalDependencies`,
  `peerDependencies`) resolves, with Node's lookup rules, to the same content from the place
  of each copy and from the place of the shared copy. This is what guarantees that moving a
  copy never changes which version any package gets.

A copy that fails a rule is left alone, and the build log says which one and why. The shared
copy is the one at the top level of `node_modules` if there is one, otherwise it is moved to
`node_modules/.dsh-shared/<name>@<version>`. Node resolves a symlink to its real path, so all
users share one module instance. After the step, `scripts/verify-resolution.mjs` takes a
snapshot of "which name@version does every package location get for every dependency it
declares" before and after, and the build fails if any answer changed. The numbers (files,
bytes, groups) are in the build log, in `dedupe-<abi>.json` and in the release notes. Layers
may already contain symlinks, so the layer format does not change.

### Module pack

`/usr/local/bin/dsh` starts the harness as `exec /opt/node/bin/node --import
/opt/dsh/runtime-pack/preload.mjs .../lib/bin.js "$@"`. The guest's main process is still
node. The preload answers Node's module resolve and load steps, and a few `fs` calls, for
files under `/opt/dsh` from one file, `/opt/dsh/runtime-pack/pack.bin`, recorded at build
time. A start then needs about 4,000 path calls instead of 37,000 (after sharing packages)
or 55,000 (before).

| Variable | Effect |
|---|---|
| `DSH_RUNTIME_MODULE_PACK` | `0`, `off`, `false` or `no` (any case) turns the pack off. Unset or any other value leaves it on. Set it in the guest's environment, for example in the `env -i ...` list of the command line above. This is the kill switch. |
| `DSH_RUNTIME_MODULE_PACK_DEBUG` | `1` makes the preload print on stderr that it is on and, at exit, how many resolves, loads and fs answers it served. For diagnosis only. |

What the pack contains and what it never serves:

- It holds resolve results, module sources (ES modules, CommonJS and JSON), `package.json`
  files read with `fs.readFileSync`, and the answers of `fs.existsSync`,
  `fs.realpathSync`, `fs.realpathSync.native` and `fs.readlinkSync`, only for paths and file
  URLs under `/opt/dsh`.
- A resolve is served only when the importing file is under `/opt/dsh` (or the specifier is
  already an absolute path under it) and the answer is under `/opt/dsh` or a Node.js built-in.
  Everything outside the tree, such as your home directory, workspaces, and plugins
  installed later under `/root/.dsh`, always goes through normal Node.js resolution and
  file reading. A package of the same name in your own `node_modules` is not shadowed.
- Anything the pack does not know (a miss) is handled by Node.js as if the pack did not exist.
  Every hook and every `fs` wrapper catches its own exceptions and falls back the same way.
- The pack is not used in worker threads or in child processes started with an IPC channel.

How it stays correct:

- **Build id.** The pack carries a build id: a hash of the structure of `/opt/dsh`
  (every path, size and mode, not the contents), the harness version, the architecture and
  the Node.js version. At start the preload reads `/opt/dsh/build-id` (one small read) and
  compares. Any mismatch turns the pack off. It also checks the pack's magic words and exact
  size, the Node.js version, platform and CPU architecture, and the size of
  `/opt/dsh/node_modules/.package-lock.json` (one `stat`), so a truncated or damaged pack, a
  pack for another build, or an `npm install` into `/opt/dsh` is noticed. There are no
  per-file checks, because those would bring the system calls back.
- **Switching off is quiet.** When the pack turns itself off it prints one line starting
  with `dsh module pack: off:` to stderr and nothing to stdout, so the readiness line is
  never disturbed. The kill switch prints nothing.
- **If the preload fails.** `preload.mjs` catches everything, including a failure to load
  `replay.mjs`. A missing preload file is checked by the launcher with `test -f`.
- **What it does not detect.** Changes to a single file under `/opt/dsh` that keep every
  file size, or bit flips inside a valid pack, are not detected. `/opt/dsh` belongs to the
  harness layer and is replaced as a whole (see "Layers and updates"); do not edit it.

This relies on `module.registerHooks`, an API that Node.js does not yet document as stable.
It was developed and validated with Node.js
24.22.3, the version this runtime ships, and the preload records that version and refuses a
pack made by another one. Node.js is pinned in the base layer, so the pack and its node always
belong together unless something replaces `/opt/node` alone; if a Node.js without
`registerHooks` ever runs it, the preload turns the pack off and the harness runs the normal
way, slower but correct. Bumping `NODE_VERSION` in `scripts/versions.env` rebuilds the pack,
and the smoke test below has to pass before a release.

The pack is recorded in the build (`scripts/record-pack.sh`) by running the real harness
from the finished tree, with the same node binary and the same paths the bundle ships: it
starts, exchanges the token, and makes the calls in `scripts/module-pack/calls.json`
(`session/list`, `session/create` in a temporary workspace, and a few cheap calls that pull
in lazily loaded modules: settings, providers, plugin manager, schedule and others), then
fetches the web page. A start that does something else may miss and fall back. The recording
run must leave `/opt/dsh` unchanged, and the pack is replayed once more to check that it
switches on and answers nearly everything.

## Shell commands and permissions on Android

### Why there is no kernel sandbox here

The harness normally runs the model's shell commands inside a kernel sandbox (bubblewrap, or
Landlock) and refuses to run a command when neither works. Its default mode, "Workspace Write",
depends on one of them. Neither can work inside an Android app: Android kernels are built without
user namespaces (so no bubblewrap), the Landlock system calls are not on Android's seccomp list for
apps, and proot cannot make anything read-only. So in upstream's default mode every shell command
fails with `SANDBOX_UNAVAILABLE`, and the harness cannot run a single command.

This runtime therefore ships two presets of its own, in the harness layer, and starts `dsh web` with
them. It changes no file of the harness.

| Preset id | Name the harness reports | What it does |
|---|---|---|
| `danger-full-access` | Full access | Upstream's own full-access bundle: shell commands and file changes run without asking. **The default.** |
| `ask-commands` | Ask before commands | The same file access, but every shell command waits for an approval that shows the command. |

The ids and names are what `permissionPresets/catalog` returns from the running harness; CI checks
them on both architectures. A new session starts on the default preset, and `/permission <id>` (or
the harness's permission control) switches a session. The harness's own presets `read-only` and
`workspace-write` are not offered: they could not run a command here anyway.

### What Android still isolates, and what it does not

Everything the runtime runs is part of the app: one Android user id, with the app's private storage
only.

- **Isolated:** the runtime cannot reach the user's photos, files in shared storage, contacts,
  messages, or other apps and their data. This holds in both presets.
- **Not isolated:** the network is open (a command can download and upload anything). A command can
  delete or change the workspace and the whole harness home (`/root/.dsh`: session history, settings,
  the stored API key), and can break the runtime's own files. A command, or the harness's own `read`
  tool, can read the stored API key; that is also true in upstream's default mode. A command may be
  able to end the app's own processes (same user id; not tried on a device).

"Ask before commands" lets the user read each command before it runs. It is a question, not a
sandbox: a command the user allows has the full reach described above, and a user who taps allow
without reading gets no protection from it.

### Choosing the default: `DSH_RUNTIME_DEFAULT_PERMISSION`

Set it in the guest's `env -i ...` list (see "Running"). The launcher passes it through to the harness
and the patch reads it.

| Value | New sessions start on |
|---|---|
| unset, empty, `full` (also `danger-full-access`) | `danger-full-access` (Full access) |
| `ask` | `ask-commands` (Ask before commands) |
| anything else | `ask-commands`, and the launcher prints a warning on stderr (the safer preset wins a typo) |

The value is read once, when the harness starts; to change it, restart the harness. Values are
compared without case and without spaces around them. A preset a user chose in a session stays with
that session. If the user saved a default preset in the harness's own settings, that saved choice
wins over this variable (the harness's own rule; not exercised by CI), so an app that offers this
choice should not also write the harness's default setting.

### Turning the patch off: `DSH_RUNTIME_MOBILE_PATCH=0`

`0`, `off`, `false` or `no` (any case) makes the launcher leave `--patch` out. The harness then is
exactly the upstream one: presets `read-only`, `workspace-write` (the default) and
`danger-full-access`, and every shell command is refused with `SANDBOX_UNAVAILABLE` in the default
mode. Use it to rule the patch out while troubleshooting, or to compare. CI checks that it gives back
upstream's presets and its refusal. `DSH_RUNTIME_MOBILE_PATCH` and `DSH_RUNTIME_DEFAULT_PERMISSION` are
the only two variables involved.

### What "Ask before commands" gates, and what it does not

It acts on every model-initiated tool call, before the tool body starts, through the harness's own
per-call gate (`tools/pre-execute`). The question goes to the app through the same approval request
the harness already uses (`approval/request`, answered `allowed-once` or `rejected`), with the
command in the reason and in `displayReason.en`. Only an `allowed-once` answer lets that one call
run. A reject, a cancel, no answering client, or an error ends in a denial, and nothing runs.

| Path | Gated in "Ask before commands"? | Checked by CI |
|---|---|---|
| The shell tool `bash` (standard agent preset), also with `run_in_background` | Yes: held for an approval | Yes |
| The persistent shell (the `bash` tool of the minimal agent preset) | Yes: same tool name | Yes |
| Code mode `run_code` (the ptc agent preset), whose program can start processes | Yes: held, the approval shows the program | Yes |
| Tools a code-mode program or a workflow calls | Each nested call goes through the same pipeline, so the gate sees it (by the harness's design; not exercised separately) | No |
| Subagents (`subagent`, `subagent_fork`, a workflow's `agent()`) | A subagent cannot ask anyone (the harness pins its approval policy to "never"), so its shell calls, `run_code` and file changes outside the workspace are **denied**, and it is told to say so. Subagents of a Full access session run freely | Yes, for `subagent` |
| `plugin_manager` actions that change something (`set_plugin`, `set_bundle`, `install_bundle`, `remove_bundle`, `set_version_exemption`) | Yes. The `list_*` actions are not asked | Yes |
| `write` and `edit` on a file outside the workspace (the workspace is the session's folder; the temp directory is allowed too) | Yes: held. Inside the workspace they run without a question. Links are followed, so a link inside the workspace that points out is caught | Yes |
| `read`, `glob`, `grep`, and the web tools | No. They run in both presets. The harness's `read` can return any file, including the stored API key | Yes (`read`) |
| `terminal_open` and `terminal_send` (model-facing terminal tools of the harness's optional terminal bundle) | Gated by name; the default profile does not mount them | No |
| The terminal panel of the web page, and anything the user types there | **No.** It is the user typing into a shell, not a model call; there is nothing to ask | No |
| A scheduled task | Not gated itself: its new sessions use the preset of the session that made it, and are gated like any session | No |
| MCP servers the user configures in the harness | **No.** The harness starts them as its own processes; the gate sees only the tools they offer | No |

In **Full access** the gate does nothing at all. Upstream's full-access mode also switches off the
harness's file path fence, so `write` and `edit` can change any file the app can reach, with no
question; CI pins this so a change shows. There is no "workspace path check" in either preset
except the one the gate adds in "Ask before commands".

Also true in "Ask before commands": the file tools can still change files inside the workspace, and
the workspace may hold anything (a script the user later runs, a `.git/hooks` entry). The question
guards commands and changes outside the workspace, not what the model writes into the workspace.
The path of a `write` is judged by its text and by links as they are when the call is made; a
relative path counts as relative to the workspace.

### Fail closed

The gate and the preset service are one module, `/opt/dsh/mobile/permission.mjs`, which extends the
harness's own preset service class. This is on purpose. The harness starts even when a plugin cannot
load (it only prints `dsh: warning: 1 entry did not activate`), so a separate gate plugin that failed
to load would have left "Ask before commands" running commands without asking.

- If `permission.mjs` cannot load, throws while starting, or needs a service that does not exist, the
  harness starts with no presets at all. The patch leaves the harness's own deployment default
  (`workspace-write`) in place, and only this module ever puts a session on full access, so every
  shell command is refused as upstream refuses it. Nothing runs unasked.
- If the module loads and its gate throws while a call is being checked, the harness answers that
  call with an error and does not run it, even if the user would have allowed it.

CI starts the harness with the module missing, with a syntax error, with a constructor that throws,
with a required service that does not exist, and with a gate that throws, and requires that no
command runs and no file appears. It also checks that the harness reports the module as not active.
What this does not cover: the model's file tools can overwrite `/opt/dsh/mobile/permission.mjs` or
the harness's configuration in "Ask before commands", because writes outside the workspace need a
question but a user can allow one. "Ask before commands" is not a security boundary against a user
who allows everything it asks.

### How the build keeps this working, also for automatic releases

The patch and module are part of the harness layer (`/opt/dsh/mobile/`, installed by
`scripts/build-layers.sh` before the module pack is recorded, so the pack's build id covers them;
the pack is recorded and replayed with the same `--patch` the launcher uses). The 6-hourly automatic
release builds new harness versions through the same script, so every release carries them.
Two things make a harness version that no longer fits fail the build instead of shipping:

1. `scripts/mobile/check-interfaces.mjs` runs inside the build against the installed harness. It
   checks the rows the patch replaces, the `tools/pre-execute` gate and the way an `ask` is resolved,
   the service classes and methods the module reads, and the session header that names a subagent's
   parent. It stops the build with a message that says what changed.
2. The smoke test (above) then proves the behaviour itself on both architectures. A release is only
   created if both pass.

### What the app has to do

1. Read `runtime.permissions` in the manifest. If it is absent, the installed runtime has no presets
   and no switches (older release): do not pass `DSH_RUNTIME_*` variables expecting an effect.
2. To choose the default for new sessions, add `DSH_RUNTIME_DEFAULT_PERMISSION=full` or `=ask` to the
   `env -i ...` list of the guest command (see "Running"), and restart the harness after a change.
   Do not also write the harness's own default-preset setting.
3. Use `permissionPresets/catalog` for the list of presets, and `/permission <id>` to switch a
   session. Show the app's own localized names and text for `danger-full-access` and `ask-commands`.
4. Answer `approval/request` as it already does. The command is in `reason` (`bash: <command>`) and in
   `displayReason.en`. Answer `allowed-once` or `rejected`.
5. A tool result with the error code `SANDBOX_UNAVAILABLE` means the session is on a mode that needs a
   kernel sandbox: sessions made by an older runtime that were left on `workspace-write`, or a run
   with `DSH_RUNTIME_MOBILE_PATCH=0`. The way out is to switch the session to a preset above. Such an
   old session reports its preset as `custom` until it is switched (checked once by hand against a
   session made by upstream's harness; not part of CI).
6. Do not set `DSH_PERMISSION_MODE`: the patch does not read it.

## How the build works

Everything runs in [`.github/workflows/build-runtime.yml`](.github/workflows/build-runtime.yml):

1. **proot for Android** (`ubuntu-24.04`): `scripts/build-proot-android.sh` downloads the
   pinned proot commit and talloc release (checked against pinned SHA-256 values), builds a
   static `libtalloc.a` with the NDK, then proot and its loader for both ABIs with
   `-z max-page-size=16384`, the unbundled loader, and no 32-bit loader. It fails if the
   binaries need any library besides Android's libc, libdl and libm, have an RPATH, or contain
   a Termux path.
2. **Layers** (`ubuntu-24.04-arm` for arm64, `ubuntu-24.04` for x86_64, each native):
   `scripts/build-layers.sh` runs in a privileged `debian:trixie` container. It builds the
   base with `mmdebstrap` from snapshot.debian.org at the pinned date, adds Node.js (checked
   against `SHASUMS256.txt`, whose GPG signature is checked against the Node.js release
   keys), applies the root file system fixes, and packs the base layer. It then installs the
   harness with npm inside the tree (chroot, install scripts enabled), proves nothing outside
   the harness paths changed, shares identical nested packages (`scripts/dedupe-modules.py`,
   checked with `scripts/verify-resolution.mjs`), installs `/opt/dsh/mobile` and checks it against
   the harness (`scripts/mobile/check-interfaces.mjs`), prunes, checks ELF alignment, records the
   module pack (`scripts/record-pack.sh`) and packs the harness layer.
3. **Pruning** (`scripts/prune.py`) only removes directories named for another OS or another
   CPU architecture (such as `prebuilds/win32-x64` or `prebuilds/linux-arm64` on x86_64) that
   hold native binaries and no JavaScript or package files. Every removal and its size is in
   the build log and in `prune-<abi>.json`.
4. **Checks before a release**: `readelf -lW` on every ELF file: in the arm64 bundle and in
   both proot builds each LOAD segment must be aligned to 16 KB or more; for the x86_64 bundle
   the result is only reported (Debian builds x86_64 with 4 KB alignment). Then
   `scripts/smoke-test.sh` unpacks both layers as an unprivileged user, runs a few guest checks
   (git, ripgrep, hard links, `os.cpus()`), and starts the harness under a Linux build of the
   same proot commit with the command line above. It waits for the readiness line, expects
   401 from `/api/session/list` without a session, exchanges the token for the session cookie,
   expects 200 from an authenticated `/api/session/list`, and stops the harness with the stop
   sequence above. It does this with the module pack on and with `DSH_RUNTIME_MODULE_PACK=0`,
   makes the same two dozen calls (`scripts/module-pack/calls.json`) in both modes and requires
   identical JSON apart from ids and timestamps. It then starts the harness with a stale build
   id, a truncated pack, a pack with a zeroed head, a missing pack, a missing build id, a
   preload that throws, a preload with a syntax error and a missing preload: every one must
   still reach readiness and pass the session checks, with a pack message only on stderr.
   It runs a tiny ES module package under `/root` twice with different contents and requires the
   current content each time, so a module outside `/opt/dsh` is never served from the pack.
   It then runs the shell permission checks (`scripts/shell-tests/`): a tiny local HTTP server plays
   the model and asks for real tool calls, so the real harness runs its real tools under proot, and an
   approval client speaking the harness's own client protocol answers the questions. It covers Full
   access and Ask before commands (allow, reject, cancel, subagents, file tools, `plugin_manager`, the
   persistent shell, code mode), both defaults, the escape hatch, and the permission module broken in
   five ways (fail closed).
   Finally it measures the start to readiness three times for pack on and pack off and, when
   `strace` and passwordless `sudo` exist (they do on GitHub runners), counts the path system
   calls of one start of each natively. These results are in the job summary and the release
   notes. The token is masked in the log. A failure anywhere stops the build before any
   release is created.
5. **Release**: `scripts/assemble-release.py` writes `manifest.json` and the notes,
   `scripts/sign-manifest.sh` signs it with the `RUNTIME_SIGNING_KEY` secret (and checks the
   signature against the committed public key), writes `SHA256SUMS.txt`, and the job creates
   the GitHub release. Before writing the manifest, the assembler downloads the manifest of
   the previous published release and fails the build if any layer has the same `id` as the
   same layer there but a different `sha256`. It also writes the optional `previous` field,
   keeps `sequence` above the previous one, and puts what changed (harness, Node.js, base) and
   the per-architecture download sizes into the release notes. The job then downloads the
   published release without a token and verifies it again.

Pinned inputs live in [`scripts/versions.env`](scripts/versions.env). Tar files are built
with sorted names, fixed owners and fixed times, so unchanged inputs give the same tar content.

## Cutting a release

Releases normally happen by themselves (see "How updates reach the app"). To start one by hand,
run **Build runtime** from the Actions tab, or:

```sh
gh workflow run build-runtime.yml --repo sorsama/dsh-mobile-runtime \
  -f harness_version=latest -f rebuild=true -f min_app_version=0.22.0
```

| Input | Default | Meaning |
|---|---|---|
| `harness_version` | `latest` | npm version or dist-tag of `@deepseek-ai/dsh`; resolved to an exact version. |
| `rebuild` | `false` | Build even if a release already carries that harness version. Without it, a run for a version that already has a release ends quietly. |
| `release_id` | UTC date and next free number of that day | The release tag. Must not exist yet. |
| `min_app_version` | empty (same as the previous release, else `0.22.0`) | Written to the manifest. |
| `dry_run` | `false` | Build and check everything, sign the manifest, but publish nothing. The manifest is kept as a workflow artifact. Needs no `rebuild`. |
| `report_failures` | `false` | Open or update the failure issue if this run fails (scheduled runs always do). |
| `simulate_failure` | `none` | Test only. `early` fails before any build job, `late` fails after signing, just before publishing. |

To change Debian, Node.js, proot or talloc, edit `scripts/versions.env` (bump
`BASE_REVISION` when the base recipe changes without a version change).

The signing key's private half exists only in the repository secret `RUNTIME_SIGNING_KEY`
and in an offline backup. If it is ever replaced, the app must ship the new public key
before any release signed with it.

## Licenses

The build scripts in this repository are under the [MIT license](LICENSE). The bundles
contain third-party software under its own licenses: see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). In short: proot is GPL-2.0-or-later and
talloc LGPL-3.0-or-later, and their exact sources are attached to every release; Debian
packages carry their copyright files inside the base layer; Node.js and the DeepSeek Harness
are MIT.
