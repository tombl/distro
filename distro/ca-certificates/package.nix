{ pkgs }:

pkgs.runCommand "ca-certificates-${pkgs.cacert.version}"
  {
    passthru.apk = {
      name = "ca-certificates";
      version = "${pkgs.cacert.version}-r0";
      description = "Mozilla CA certificate bundle";
      license = "MPL-2.0";
    };
  }
  ''
    mkdir -p $out/etc/ssl
    cp ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt $out/etc/ssl/cert.pem
  ''
