{
  run,
  inputs,
}:

run
  {
    name = "compiler-rt";
    src = inputs.libclang_rt;
  }
  ''
    mkdir -p $out
    cp libclang_rt.builtins-wasm32.a $out/
  ''
