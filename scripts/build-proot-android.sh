#!/usr/bin/env bash
# Builds proot and its loader for Android (arm64-v8a and x86_64) with the NDK.
# talloc is built from source and linked statically, so the only runtime
# dependencies are Android's own libc/libdl. No Termux paths are compiled in:
# the app passes PROOT_LOADER and PROOT_TMP_DIR at run time.
#
# Usage: build-proot-android.sh <out-dir>
# Needs: ANDROID_NDK_ROOT, curl, make, python3 (for talloc's waf configure), readelf.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=versions.env
. "$HERE/versions.env"

OUT=$(realpath -m "$1")
WORK=$(realpath -m "${WORK:-$PWD/work/proot-android}")
NDK=${ANDROID_NDK_ROOT:?set ANDROID_NDK_ROOT}
TC=$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin
mkdir -p "$OUT" "$WORK/dl"

fetch() { # url file sha256
  [ -f "$2" ] || curl -fsSL --retry 5 --retry-all-errors -o "$2" "$1"
  echo "$3  $2" | sha256sum -c --quiet - || { echo "checksum mismatch for $1" >&2; exit 1; }
}

PROOT_TGZ=$WORK/dl/proot-$PROOT_COMMIT.tar.gz
TALLOC_TGZ=$WORK/dl/talloc-$TALLOC_VERSION.tar.gz
fetch "$PROOT_REPO/archive/$PROOT_COMMIT.tar.gz" "$PROOT_TGZ" "$PROOT_SRC_SHA256"
fetch "https://www.samba.org/ftp/talloc/talloc-$TALLOC_VERSION.tar.gz" "$TALLOC_TGZ" "$TALLOC_SHA256"

# The exact sources, published next to the binaries (GPL-2.0 / LGPL-3.0).
cp "$PROOT_TGZ" "$OUT/proot-source-$PROOT_COMMIT.tar.gz"
cp "$TALLOC_TGZ" "$OUT/talloc-source-$TALLOC_VERSION.tar.gz"

echo "NDK: $(sed -n 's/^Pkg.Revision *= *//p' "$NDK/source.properties")"
"$TC/clang" --version | head -1

for abi in arm64-v8a x86_64; do
  case $abi in
    arm64-v8a) triple=aarch64-linux-android ;;
    x86_64) triple=x86_64-linux-android ;;
  esac
  CC="$TC/${triple}${ANDROID_API}-clang"
  B=$WORK/$abi
  rm -rf "$B"; mkdir -p "$B/talloc" "$B/proot" "$B/sysroot/lib" "$B/sysroot/include"

  echo "::group::talloc $TALLOC_VERSION for $abi"
  tar -xzf "$TALLOC_TGZ" -C "$B/talloc" --strip-components=1
  cp "$HERE/talloc-cross-answers.txt" "$B/talloc/cross-answers.txt"
  if ! (cd "$B/talloc" && CC="$CC" AR="$TC/llvm-ar" ./configure --disable-python --disable-rpath \
        --cross-compile --cross-answers=cross-answers.txt >configure.log 2>&1); then
    tail -40 "$B/talloc/configure.log"
    echo "--- cross answers after the failed run (UNKNOWN lines need an answer):"
    cat "$B/talloc/cross-answers.txt"
    exit 1
  fi
  # Only waf's config.h is needed. Compile the two objects directly so the
  # static archive holds exactly talloc plus the libreplace helpers it uses.
  common=(-O2 -fPIC -D_GNU_SOURCE=1 -D_XOPEN_SOURCE_EXTENDED=1 -D__STDC_WANT_LIB_EXT1__=1
          -I"$B/talloc/bin/default" -I"$B/talloc" -I"$B/talloc/lib/replace")
  (cd "$B/talloc" &&
    "$CC" "${common[@]}" -DSTATIC_talloc_MODULES=NULL \
      "-DSTATIC_talloc_MODULES_PROTO=extern void __talloc_dummy_module_proto(void)" \
      -c talloc.c -o talloc.o &&
    "$CC" "${common[@]}" -D_PUBLIC_=_PRIVATE_ -DSTATIC_replace_builtin_MODULES=NULL \
      "-DSTATIC_replace_builtin_MODULES_PROTO=extern void __replace_builtin_dummy_module_proto(void)" \
      -c lib/replace/replace.c -o replace.o &&
    "$TC/llvm-ar" rcsD "$B/sysroot/lib/libtalloc.a" talloc.o replace.o)
  cp "$B/talloc/talloc.h" "$B/sysroot/include/"
  echo "::endgroup::"

  echo "::group::proot $PROOT_VERSION ($PROOT_COMMIT) for $abi"
  tar -xzf "$PROOT_TGZ" -C "$B/proot" --strip-components=1
  # Environment flags: the GNUmakefile appends to them with +=.
  # GIT=false keeps the version string from picking up this repo's git tags.
  # HAS_LOADER_32BIT= drops the 32-bit loader (no 32-bit guests here).
  env \
    CPPFLAGS="-I$B/sysroot/include -DARG_MAX=131072 -DVERSION=\\\"$PROOT_VERSION\\\"" \
    LDFLAGS="-L$B/sysroot/lib -Wl,-z,max-page-size=16384" \
    LOADER_LDFLAGS="-Wl,-z,max-page-size=16384" \
    make -C "$B/proot/src" -j"$(nproc)" V=1 \
      CC="$CC" STRIP="$TC/llvm-strip" OBJCOPY="$TC/llvm-objcopy" OBJDUMP="$TC/llvm-objdump" \
      GIT=false HAS_LOADER_32BIT= PROOT_UNBUNDLE_LOADER="$PROOT_UNBUNDLE_LOADER" \
      proot loader/loader
  echo "::endgroup::"

  "$TC/llvm-strip" -o "$OUT/android-$abi-libproot.so" "$B/proot/src/proot"
  "$TC/llvm-strip" -o "$OUT/android-$abi-libproot-loader.so" "$B/proot/src/loader/loader"
  chmod 755 "$OUT/android-$abi-libproot.so" "$OUT/android-$abi-libproot-loader.so"

  echo "== $abi dynamic section of libproot.so"
  readelf -dW "$OUT/android-$abi-libproot.so" | grep -E 'NEEDED|RPATH|RUNPATH|SONAME' || true
  if readelf -dW "$OUT/android-$abi-libproot.so" | grep -E 'NEEDED' | grep -vE '\[(libc|libdl|libm)\.so\]'; then
    echo "libproot.so needs a library Android does not provide" >&2; exit 1
  fi
  if readelf -dW "$OUT/android-$abi-libproot.so" | grep -qE 'RPATH|RUNPATH'; then
    echo "libproot.so has an RPATH/RUNPATH" >&2; exit 1
  fi
  if strings "$OUT/android-$abi-libproot.so" "$OUT/android-$abi-libproot-loader.so" | grep -q 'com\.termux'; then
    echo "a Termux path is compiled in" >&2; exit 1
  fi
  echo "== $abi loader"
  readelf -hW "$OUT/android-$abi-libproot-loader.so" | grep -E 'Type|Machine'
  readelf -dW "$OUT/android-$abi-libproot-loader.so" 2>&1 | head -3
done

ls -la "$OUT"
