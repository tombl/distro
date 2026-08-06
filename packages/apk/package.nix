{
  pkgs,
  lib,
  tools,
  dependency,
  platform,
}:

let
  normalizeSource =
    source:
    if builtins.typeOf source == "path" then
      builtins.path {
        path = source;
        name = builtins.baseNameOf source;
      }
    else
      source;

  mkPackage =
    {
      payload,
      name,
      version,
      description ? name,
      license ? "unknown",
      origin ? name,
      arch ? platform.apkArch,
      url ? null,
      maintainer ? null,
      depends ? [ ],
      provides ? [ ],
      replaces ? [ ],
      installIf ? [ ],
      providerPriority ? null,
      replacesPriority ? null,
      tags ? [ ],
      scripts ? { },
      triggers ? [ ],
    }:
    let
      renderPackageName =
        value:
        if builtins.isAttrs value && (value.isApk or false) then
          value.name
        else
          throw "APK replaces entries must be APK package values";
      renderedReplaces = map renderPackageName replaces;
      filename = "${name}-${version}.apk";
      normalizedScripts = builtins.mapAttrs (_type: normalizeSource) scripts;
      renderedDepends = dependency.renderAll depends;
      renderedInstallIf = dependency.renderAll installIf;
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
      // lib.optionalAttrs (renderedReplaces != [ ]) {
        replaces = lib.concatStringsSep " " renderedReplaces;
      }
      // lib.optionalAttrs (renderedInstallIf != "") { install-if = renderedInstallIf; }
      // lib.optionalAttrs (url != null) { inherit url; }
      // lib.optionalAttrs (maintainer != null) { inherit maintainer; }
      // lib.optionalAttrs (providerPriority != null) { provider-priority = toString providerPriority; }
      // lib.optionalAttrs (replacesPriority != null) { replaces-priority = toString replacesPriority; }
      // lib.optionalAttrs (tags != [ ]) { tags = lib.concatStringsSep " " tags; };
      infoArgs = lib.concatMapStringsSep " " (
        field: "--info ${lib.escapeShellArg "${field}:${info.${field}}"}"
      ) (builtins.attrNames info);
      scriptArgs = lib.concatMapStringsSep " " (
        type: "--script ${lib.escapeShellArg "${type}:${toString normalizedScripts.${type}}"}"
      ) (builtins.attrNames normalizedScripts);
      triggerArgs = lib.concatMapStringsSep " " (
        trigger: "--trigger ${lib.escapeShellArg trigger}"
      ) triggers;
      drv =
        pkgs.runCommand "apk-package-${name}-${version}"
          {
            nativeBuildInputs = [
              pkgs.fakeroot
              tools
            ];
            passthru = {
              isApk = true;
              inherit
                arch
                depends
                filename
                installIf
                name
                origin
                payload
                version
                ;
            };
          }
          ''
            mkdir $out root
            cp -a --no-preserve=ownership ${payload}/. root/
            chmod -R u+w root

            # Nix's patchShebangs fixup makes scripts runnable by the build
            # platform, but those store paths do not exist in the guest. Turn
            # known interpreters back into their FHS interfaces before scanning
            # dependencies and constructing the payload.
            find root -type f -perm /111 -print0 | while IFS= read -r -d ''' file; do
              IFS= read -r first < "$file" || true
              case "$first" in
                '#!'/nix/store/*/bin/*)
                  interpreter_line=''${first#'#!'}
                  interpreter=''${interpreter_line%%[[:space:]]*}
                  arguments=''${interpreter_line#"$interpreter"}
                  case "$interpreter" in
                    */bin/sh) guest_interpreter=/bin/sh ;;
                    */bin/bash) guest_interpreter=/bin/bash ;;
                    */bin/python | */bin/python3) guest_interpreter=/usr/bin/python3 ;;
                    */bin/perl) guest_interpreter=/usr/bin/perl ;;
                    */bin/env) guest_interpreter=/usr/bin/env ;;
                    *) continue ;;
                  esac
                  {
                    printf '#!%s%s\n' "$guest_interpreter" "$arguments"
                    tail -n +2 "$file"
                  } > "$file.apk-shebang"
                  chmod --reference="$file" "$file.apk-shebang"
                  mv "$file.apk-shebang" "$file"
                  ;;
              esac
            done

            # apk mkpkg deliberately performs no abuild-style command tracing.
            # Derive versioned command providers from the public executable paths
            # in the payload. Symlinked BusyBox applets are included as commands.
            inferred_provides=$(
              for directory in bin sbin usr/bin usr/sbin; do
                [ -d root/$directory ] || continue
                find root/$directory -mindepth 1 -maxdepth 1 -type f -perm /111 -printf '%f\n'
                find root/$directory -mindepth 1 -maxdepth 1 -type l -print0 |
                  while IFS= read -r -d ''' link; do
                    command=$(basename "$link")
                    target=$(readlink "$link")
                    # BusyBox owns hundreds of applet links. Advertising every
                    # one as a versioned provider would make ordinary replacement
                    # packages conflict at solve time; /bin/sh is its actual
                    # interpreter interface. Other packages' executable aliases
                    # remain useful command providers.
                    case "$target:$command" in
                      *busybox:sh) echo "$command" ;;
                      *busybox:*) ;;
                      *) echo "$command" ;;
                    esac
                  done
              done | sort -u | sed -E 's|^|cmd:|; s|$|=${version}|'
            )

            # Text executables bring their interpreter as a runtime dependency.
            # Executable examples and templates under /usr/share are not runtime
            # programs: requiring all of their optional interpreters would make,
            # for example, Git's Watchman sample pull Perl into every system.
            # wasm binaries have no shebang and static linkage has no shared-object
            # dependencies to trace.
            inferred_depends=$(
              find root -path root/usr/share -prune -o -type f -perm /111 -print0 |
                while IFS= read -r -d ''' file; do
                IFS= read -r first < "$file" || true
                case "$first" in
                  '#!'*/sh | '#!'*/sh\ *) echo cmd:sh ;;
                  '#!'*/bash | '#!'*/bash\ *) echo cmd:bash ;;
                  '#!'*/python | '#!'*/python\ * | '#!'*/python3 | '#!'*/python3\ *) echo cmd:python3 ;;
                  '#!'*/perl | '#!'*/perl\ *) echo cmd:perl ;;
                  '#!'*/env\ sh | '#!'*/env\ sh\ * | '#!'*/env\ -S\ sh*) echo cmd:sh ;;
                  '#!'*/env\ bash | '#!'*/env\ bash\ * | '#!'*/env\ -S\ bash*) echo cmd:bash ;;
                  '#!'*/env\ python | '#!'*/env\ python\ * | '#!'*/env\ python3 | '#!'*/env\ python3\ * | '#!'*/env\ -S\ python*) echo cmd:python3 ;;
                  '#!'*/env\ perl | '#!'*/env\ perl\ * | '#!'*/env\ -S\ perl*) echo cmd:perl ;;
                esac
              done | sort -u
            )

            explicit_provides=${lib.escapeShellArg (lib.concatStringsSep " " provides)}
            explicit_depends=${lib.escapeShellArg renderedDepends}
            all_provides=$(printf '%s\n%s\n' "$explicit_provides" "$inferred_provides" | xargs)
            all_depends=$(
              printf '%s\n%s\n' "$explicit_depends" "$inferred_depends" |
                tr ' ' '\n' |
                awk 'NF && !seen[$0]++' |
                while IFS= read -r dep; do
                  case " $all_provides " in
                    *" $dep="* | *" $dep "*) ;;
                    *) echo "$dep" ;;
                  esac
                done | xargs
            )

            dynamic_info=()
            [ -z "$all_provides" ] || dynamic_info+=(--info "provides:$all_provides")
            [ -z "$all_depends" ] || dynamic_info+=(--info "depends:$all_depends")

            fakeroot -- sh -c 'chown -R 0:0 root; exec "$@"' -- apk mkpkg \
              --compression deflate:9 \
              --files root \
              ${infoArgs} ${scriptArgs} ${triggerArgs} \
              "''${dynamic_info[@]}" \
              --output "$out/${filename}"
          '';
    in
    drv;
in
{
  inherit mkPackage;
}
