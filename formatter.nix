{ pkgs }:

pkgs.treefmt.withConfig {
  runtimeInputs = [
    # keep-sorted start
    pkgs.actionlint
    pkgs.deadnix
    pkgs.keep-sorted
    pkgs.nixfmt-rfc-style
    pkgs.shellcheck
    pkgs.shfmt
    pkgs.statix
    # keep-sorted end
  ];

  settings = {
    on-unmatched = "info";
    tree-root-file = "flake.nix";

    formatter = {
      actionlint = {
        command = "actionlint";
        includes = [ ".github/workflows/*.yml" ];
      };
      deadnix = {
        command = "deadnix";
        options = [ "--edit" ];
        includes = [ "*.nix" ];
      };
      keep-sorted = {
        command = "keep-sorted";
        includes = [ "*" ];
      };
      nixfmt = {
        command = "nixfmt";
        includes = [ "*.nix" ];
      };
      shellcheck = {
        command = "shellcheck";
        includes = [ "*.sh" ];
      };
      shfmt = {
        command = "shfmt";
        options = [
          "-s"
          "-w"
          "-i"
          "2"
        ];
        includes = [ "*.sh" ];
      };
      statix = {
        command = "sh";
        options = [
          "-c"
          ''for file in "$@"; do statix fix "$file"; done''
          "--"
        ];
        includes = [ "*.nix" ];
      };
    };
  };
}
