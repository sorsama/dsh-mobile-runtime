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
  usr/local/bin/dsh       harness layer: launcher script, exec's node on the harness
```

Docs and man pages are left out to save space; every package's `copyright` file is kept
under `/usr/share/doc`. Apt points at `deb.debian.org`, so `apt-get update && apt-get install`
works inside the runtime.

## Layers and updates

The two layers are separate files so a harness update does not download Debian and Node again.

- **base** owns the whole tree except the harness paths (`excludes`: `/opt/dsh`,
  `/usr/local/bin/dsh`). Its `id` (for example `trixie-20261110T000000Z-node24.22.3-r1`) only
  changes when the Debian snapshot, the Node.js version or the base recipe changes.
- **harness** owns `/opt/dsh` and `/usr/local/bin/dsh`. Its `id` is `dsh-<version>`.

Update rule for the app: for each layer, compare the manifest's `id` with the one installed.
If only the harness changed, delete `/opt/dsh` and `/usr/local/bin/dsh` and unpack the new
harness layer over the existing tree. If the base changed, unpack the base into a new staging
directory, unpack the harness on top, then swap directories. User data should not live inside
the layers' paths (the harness keeps its state under `/root`; a base update replaces `/root`
unless the app moves it across).

## Manifest schema (version 1)

`manifest.json` is UTF-8 JSON. Unknown fields must be ignored.

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | int | `1`. Refuse a manifest with a higher major schema you do not know. |
| `releaseId` | string | The release tag, for example `2026.11.14-1`. |
| `sequence` | int | Increases with every release (Unix time of the build). Never install a manifest whose `sequence` is lower than the installed one. |
| `createdAt` | string | ISO 8601 UTC time of the build. |
| `minAppVersion` | string | Lowest DSH Mobile `versionName` (semver) that may install this release. |
| `signing.algorithm` | string | `Ed25519`. |
| `signing.keyId` | string | First 16 hex digits of SHA-256 of the raw 32-byte public key. |
| `signing.signatureFile` | string | `manifest.json.sig`. |
| `assetBaseUrl` | string | Prefix for asset downloads, ends with `/`. |
| `harness.package`, `harness.version` | string | `@deepseek-ai/dsh` and its exact npm version. |
| `node.version`, `node.home` | string | Node.js version, and `/opt/node`. |
| `debian.suite`, `debian.snapshot` | string | `trixie`, and the snapshot.debian.org timestamp the packages came from. |
| `debian.baseId` | string | Same as the base layer `id`. |
| `proot.repo`, `proot.commit`, `proot.version` | string | Source of proot (`termux/proot`). |
| `proot.talloc`, `proot.ndk`, `proot.androidApi` | string, string, int | talloc version (linked statically), NDK version, API level of the build. |
| `proot.sources[]` | array of file | The source tarballs published with the release. |
| `runtime.entrypoint` | string | `/usr/local/bin/dsh`. |
| `runtime.readinessPrefix` | string | `dsh web: http://127.0.0.1:`. The harness prints this, followed by `<port>/?token=<token>`, when it is ready. |
| `runtime.fakeProc[]` | array of `{source, target}` | Files to bind over `/proc` entries (see "Running"). Paths are inside the guest. |
| `runtime.resolvConf` | string | `/etc/resolv.conf`, the file the app should rewrite with the device DNS servers. |
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
| `id` | Identity of the layer content, used to decide whether it must be downloaded. |
| `compression` | `zstd`. |
| `zstdWindowLog` | `27`: the decoder needs a 128 MiB window. Standard decoders accept this without special flags. |
| `format` | `tar (GNU)`. |
| `unpackedSize` | Sum of the sizes of all regular files in the layer, in bytes. Real disk use is higher (blocks, directories, link2symlink files); check for about 1.3 times this plus some headroom before unpacking. |
| `entries` | Number of tar entries. Use it for progress. |
| `owns` | Guest paths this layer owns (`["/"]` for base). |
| `excludes` | Base only: paths inside `owns` that belong to other layers. |

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
   (`Build.SUPPORTED_ABIS`, first match).
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
   the harness paths changed, prunes, checks ELF alignment and packs the harness layer.
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
   expects 200 from an authenticated `/api/session/list`, stops the harness with the stop
   sequence above, and measures a second, warm start. The token is masked in the log.
5. **Release**: `scripts/assemble-release.py` writes `manifest.json` and the notes,
   `scripts/sign-manifest.sh` signs it with the `RUNTIME_SIGNING_KEY` secret (and checks the
   signature against the committed public key), writes `SHA256SUMS.txt`, and the job creates
   the GitHub release.

Pinned inputs live in [`scripts/versions.env`](scripts/versions.env). Tar files are built
with sorted names, fixed owners and fixed times, so unchanged inputs give the same tar content.

## Cutting a release

From the Actions tab, run **Build runtime**, or:

```sh
gh workflow run build-runtime.yml --repo sorsama/dsh-mobile-runtime \
  -f harness_version=latest -f release_id=2026.11.14-1 -f min_app_version=0.22.0
```

| Input | Default | Meaning |
|---|---|---|
| `harness_version` | `latest` | npm version or dist-tag of `@deepseek-ai/dsh`; resolved to an exact version. |
| `release_id` | UTC date and run number | The release tag. Must not exist yet. |
| `min_app_version` | `0.22.0` | Written to the manifest. |
| `dry_run` | `false` | Build and check everything, sign the manifest, but publish nothing. The manifest is kept as a workflow artifact. |

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
