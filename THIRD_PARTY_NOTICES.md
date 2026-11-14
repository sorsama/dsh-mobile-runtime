# Third-party notices

The build scripts in this repository are MIT licensed (see `LICENSE`). The release assets
contain or are built from the following third-party software. Versions are pinned in
`scripts/versions.env` and recorded in each release's `manifest.json`.

## proot

- Files: `android-<abi>-libproot.so`, `android-<abi>-libproot-loader.so` (built from source).
- Source: https://github.com/termux/proot, the exact commit in `manifest.json` (`proot.commit`).
  The unmodified source tarball is attached to every release as `proot-source-<commit>.tar.gz`.
- License: GNU General Public License, version 2 or later (GPL-2.0-or-later). The full text is
  the `COPYING` file inside the source tarball.
- Build: `scripts/build-proot-android.sh` in this repository, with the Android NDK version in
  `manifest.json` (`proot.ndk`). No source changes are applied. Anyone can rebuild the binaries
  from the attached source with that script.

## talloc

- Linked statically into `libproot.so`.
- Source: https://talloc.samba.org, release tarball attached to every release as
  `talloc-source-<version>.tar.gz` (unmodified).
- License: GNU Lesser General Public License, version 3 or later (LGPL-3.0-or-later).
  `libreplace`, also linked, is LGPL-3.0-or-later as well.
- Relinking: because talloc is linked statically, the complete source of the program it is
  linked into (proot, above) and the build script are published, so a user can rebuild
  `libproot.so` against a modified talloc.

## Debian

- Files: `dsh-runtime-base-<abi>.tar.zst`.
- A minimal Debian trixie system assembled with `mmdebstrap` from
  https://snapshot.debian.org at the timestamp in `manifest.json` (`debian.snapshot`).
  `debian-packages-<abi>.txt` lists every package and version.
- Licenses: each package's license and copyright are in `/usr/share/doc/<package>/copyright`
  inside the base layer. Debian main contains only software that meets the Debian Free
  Software Guidelines (GPL, LGPL, BSD, MIT, Apache and similar licenses). Sources for every
  package version are available from snapshot.debian.org at the same timestamp.

## Node.js

- Files: inside `dsh-runtime-base-<abi>.tar.zst`, under `/opt/node`.
- Source: the official binary release from https://nodejs.org/dist/ (`node.version` in
  `manifest.json`), unmodified apart from removing `include/`, `share/`, `README.md` and
  `CHANGELOG.md`.
- License: MIT for Node.js itself, with bundled third-party components under their own
  licenses. The full text is `/opt/node/LICENSE` inside the base layer.

## DeepSeek Harness

- Files: `dsh-runtime-harness-<abi>.tar.zst`, under `/opt/dsh`.
- Source: the `@deepseek-ai/dsh` package from the npm registry (`harness.version` in
  `manifest.json`), https://github.com/deepseek-ai/deepseek-harness.
- License: MIT. Its npm dependencies are installed unmodified under
  `/opt/dsh/node_modules`, each with its own `package.json` license field and license file
  where the package ships one. The only change is pruning prebuilt native binaries for other
  operating systems and CPU architectures (listed in each build log and `prune-<abi>.json`
  in the workflow artifacts).
