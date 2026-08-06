{ lib }:

let
  isDependency = value: builtins.isAttrs value && (value.type or null) == "apk-dependency";

  packageIdentity =
    package:
    if !(builtins.isAttrs package && (package.isApk or false)) then
      throw "apk.dep expects an apk package"
    else
      package;

  dep =
    package:
    let
      identity = packageIdentity package;
    in
    {
      type = "apk-dependency";
      kind = "package";
      inherit package;
      inherit (identity) name;
      constraint = null;
    };

  versioned =
    operator: package:
    let
      identity = packageIdentity package;
    in
    {
      type = "apk-dependency";
      kind = "package";
      inherit package operator;
      inherit (identity) name version;
      constraint = "${operator}${identity.version}";
    };

  virtual = name: {
    type = "apk-dependency";
    kind = "virtual";
    inherit name;
    constraint = null;
  };

  render =
    dependency:
    if !isDependency dependency then
      throw "APK dependencies must be constructed with apk.dep, apk.eq, apk.atLeast, or apk.virtual"
    else
      dependency.name + (if dependency.constraint == null then "" else dependency.constraint);

  packageDependencies =
    dependencies:
    map (dependency: dependency.package) (
      builtins.filter (dependency: dependency.kind == "package") dependencies
    );
in
{
  inherit
    dep
    isDependency
    packageDependencies
    render
    virtual
    ;

  eq = versioned "=";
  atLeast = versioned ">=";
  newer = versioned ">";
  atMost = versioned "<=";
  older = versioned "<";

  renderAll = dependencies: lib.concatMapStringsSep " " render dependencies;
}
