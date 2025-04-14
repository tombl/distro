_help:
    @just --list

eject pkg:
    #!/usr/bin/env bash
    set -e
    if [ -d "overrides/{{ pkg }}" ]; then
        echo "override for {{ pkg }} already exists"
        exit 1
    fi

    src=$(nix build .#{{ pkg }}.src --print-out-paths)
    mkdir -p overrides/{{ pkg }}
    cp -r $src overrides/{{ pkg }}/src
    chmod -R u+w overrides/{{ pkg }}/src
    echo "override for {{ pkg }} created in overrides/{{ pkg }}"

_nix cmd *args:
    #!/usr/bin/env bash
    if [ -d overrides ]; then
        DISTRO_OVERRIDES=$PWD/overrides exec nix {{ cmd }} --impure --print-build-logs {{ args }}
    else
        exec nix {{ cmd }} --print-build-logs {{ args }}
    fi

build pkg:
    #!/usr/bin/env bash
    set -e
    if [ ! -d "overrides/{{ pkg }}" ]; then
        exec just _nix build .#{{ pkg }}
    fi

    mkdir -p overrides/{{ pkg }}/outputs

    redirects=()
    for package in $(ls overrides); do
        if [[ $package =~ ^_ ]]; then
            continue
        fi
        for output in $(ls overrides/$package/outputs); do
            redirects+=(--redirect .#$package.$output $PWD/overrides/$package/outputs/$output)
        done
    done

    cd overrides/{{ pkg }}
    rm -rf outputs
    mkdir outputs

    exec nix develop .#{{ pkg }} --build --ignore-env "${redirects[@]}"

run *args: (_nix "run" ".#runner" "--" args)

serve *args: (_nix "run" ".#serve" "--" args)
