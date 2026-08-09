{
  pkgs,
  lib,
  tools,
  platform,
  llvm-toolchain-unwrapped,
  checkStoreReferences,
}:

let
  mkPackage =
    {
      payload,
      name,
      version ? "0-r0",
      description ? name,
      license ? "unknown",
      origin ? name,
      arch ? platform.apkArch,
      depends ? [ ],
      provides ? [ ],
      replaces ? [ ],
      scripts ? { },
    }:
    let
      filename = "${name}-${version}.apk";
      normalizedScripts = builtins.mapAttrs (
        _type: source:
        builtins.path {
          path = source;
          name = builtins.baseNameOf source;
        }
      ) scripts;
      info = {
        inherit
          arch
          description
          license
          name
          origin
          version
          ;
      }
      // lib.optionalAttrs (depends != [ ]) {
        depends = lib.concatStringsSep " " depends;
      }
      // lib.optionalAttrs (provides != [ ]) {
        provides = lib.concatStringsSep " " provides;
      }
      // lib.optionalAttrs (replaces != [ ]) {
        replaces = lib.concatStringsSep " " replaces;
      };
      infoArgs = lib.concatMapStringsSep " " (
        field: "--info ${lib.escapeShellArg "${field}:${info.${field}}"}"
      ) (builtins.attrNames info);
      scriptArgs = lib.concatMapStringsSep " " (
        type: "--script ${lib.escapeShellArg "${type}:${toString normalizedScripts.${type}}"}"
      ) (builtins.attrNames normalizedScripts);
    in
    pkgs.runCommand "apk-${name}-${version}"
      {
        nativeBuildInputs = [
          checkStoreReferences
          pkgs.fakeroot
          pkgs.perl
          llvm-toolchain-unwrapped
          tools
        ];
        passthru = {
          isApk = true;
          inherit
            arch
            filename
            name
            origin
            payload
            version
            ;
        };
      }
      ''
        mkdir -p $out root
        cp -a --no-preserve=ownership ${payload}/. root/
        chmod -R u+w root

        # Nix outputs and their dependencies are installed at store paths,
        # while all corresponding APKs are installed under /. Relocate text
        # metadata and absolute symlinks, then discard build-only paths from
        # wasm objects and archives. Binary path prefixes are overwritten with
        # the same number of slashes: this preserves section offsets while the
        # guest resolves the resulting path under /.
        while IFS= read -r -d "" link; do
          target=$(readlink "$link")
          relocated=$(printf '%s' "$target" | sed -E \
            's|/nix/store/[0123456789abcdfghijklmnpqrsvwxyz]{32}-[^/]+||g')
          if [ "$relocated" != "$target" ]; then
            ln -sfn "$relocated" "$link"
          fi
        done < <(find root -type l -print0)
        while IFS= read -r -d "" file; do
          if grep -Iq . "$file" && grep -Eq \
            '/nix/store/[0123456789abcdfghijklmnpqrsvwxyz]{32}-' "$file"; then
            sed -Ei \
              's|/nix/store/[0123456789abcdfghijklmnpqrsvwxyz]{32}-[^/[:space:]"'"'"']+||g' \
              "$file"
          fi
          llvm-strip --strip-debug "$file" 2>/dev/null || true
          perl -0777 -pi -e \
            's{/nix/store/[0123456789abcdfghijklmnpqrsvwxyz]{32}-[^/\0]+}{"/" x length($&)}ge' \
            "$file"
        done < <(find root -type f -print0)

        # APK payloads run outside Nix and must be self-contained. Check the
        # uncompressed tree, including symlink targets, before mkpkg hides file
        # contents inside its compressed archive.
        apk-check-store-references root ${lib.concatStringsSep " " (map toString (builtins.attrValues normalizedScripts))}

        # apk mkpkg builds the archive from on-disk ownership, so the payload
        # must look root-owned. fakeroot records the chown so the archive
        # entries carry root ownership without real privileges.
        fakeroot -- sh -c 'chown -R 0:0 root; exec "$@"' -- apk mkpkg \
          --compression deflate:9 \
          --files root \
          ${infoArgs} ${scriptArgs} \
          --output "$out/${filename}"
      '';

  # The derivation-to-package conversion: an ordinary guest derivation becomes
  # an APK. Metadata is optional and lives on the derivation's passthru.apk;
  # name and version fall back to the derivation's own (cross-build names carry
  # a -static-<triple> suffix, so pname/version are used directly). wasm
  # binaries are statically linked, so dependencies are only the declared ones.
  mkPackageFrom =
    drv:
    let
      meta = drv.passthru.apk or { };
      parsed = lib.parseDrvName drv.name;
      version = drv.version or parsed.version;
    in
    assert lib.assertMsg (lib.isDerivation drv) "apk.mkPackageFrom expects a derivation";
    mkPackage {
      payload = drv;
      name = meta.name or drv.pname or parsed.name;
      version = meta.version or (if version == "" then "0-r0" else "${version}-r0");
      depends = meta.depends or [ ];
      provides = meta.provides or [ ];
      replaces = meta.replaces or [ ];
      scripts = meta.scripts or { };
    };

  # Repositories, systems, and tests all accept either an APK value or a
  # derivation that has yet to be converted.
  packageFrom =
    value:
    if builtins.isAttrs value && (value.isApk or false) then
      value
    else if lib.isDerivation value then
      mkPackageFrom value
    else
      throw "apk packages must be derivations or APK package values";
in
{
  inherit
    mkPackage
    mkPackageFrom
    packageFrom
    ;
}
