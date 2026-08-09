/* In-memory TLS handshake over a BIO pair, driven straight through libssl and
 * libcrypto. A server SSL and a client SSL are wired to the two ends of a BIO
 * pair; we pump SSL_do_handshake on both sides, shuttling the ciphertext each
 * produces to the other, until both report the handshake is complete, then send
 * one application record each way and check it arrives intact.
 *
 * The server credential is an ephemeral P-256 key with a self-signed
 * certificate, built entirely in memory. The client does not verify it because
 * this test covers the record layer, key exchange and symmetric crypto rather
 * than certificate validation. On any failure the program prints an OpenSSL
 * error and exits nonzero; on success it prints "handshake ok". */

#include <stdio.h>
#include <string.h>

#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>

static int die(const char *msg) {
  fprintf(stderr, "handshake FAIL: %s\n", msg);
  ERR_print_errors_fp(stderr);
  return 1;
}

/* Build an ephemeral P-256 key and a matching self-signed certificate. */
static int make_credential(EVP_PKEY **key_out, X509 **cert_out) {
  EVP_PKEY *key = EVP_EC_gen("P-256");
  if (key == NULL)
    return 0;

  X509 *cert = X509_new();
  if (cert == NULL) {
    EVP_PKEY_free(key);
    return 0;
  }

  X509_set_version(cert, 2);
  ASN1_INTEGER_set(X509_get_serialNumber(cert), 1);
  X509_gmtime_adj(X509_getm_notBefore(cert), 0);
  X509_gmtime_adj(X509_getm_notAfter(cert), 3600);
  X509_set_pubkey(cert, key);

  X509_NAME *name = X509_get_subject_name(cert);
  X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_ASC,
                             (const unsigned char *)"wasm-tls-selftest", -1, -1,
                             0);
  X509_set_issuer_name(cert, name);

  if (X509_sign(cert, key, EVP_sha256()) == 0) {
    X509_free(cert);
    EVP_PKEY_free(key);
    return 0;
  }

  *key_out = key;
  *cert_out = cert;
  return 1;
}

int main(void) {
  EVP_PKEY *key = NULL;
  X509 *cert = NULL;
  if (!make_credential(&key, &cert))
    return die("credential generation");

  SSL_CTX *sctx = SSL_CTX_new(TLS_server_method());
  SSL_CTX *cctx = SSL_CTX_new(TLS_client_method());
  if (sctx == NULL || cctx == NULL)
    return die("SSL_CTX_new");

  if (SSL_CTX_use_certificate(sctx, cert) == 0 ||
      SSL_CTX_use_PrivateKey(sctx, key) == 0)
    return die("loading server credential");
  SSL_CTX_set_verify(cctx, SSL_VERIFY_NONE, NULL);

  SSL *ssl_s = SSL_new(sctx);
  SSL *ssl_c = SSL_new(cctx);
  if (ssl_s == NULL || ssl_c == NULL)
    return die("SSL_new");

  /* A BIO pair is two joined memory buffers: what one side writes, the other
   * reads. One half goes to the client SSL, the other to the server SSL. */
  BIO *bio_c = NULL, *bio_s = NULL;
  if (BIO_new_bio_pair(&bio_c, 0, &bio_s, 0) == 0)
    return die("BIO_new_bio_pair");
  SSL_set_bio(ssl_c, bio_c, bio_c);
  SSL_set_bio(ssl_s, bio_s, bio_s);

  SSL_set_connect_state(ssl_c);
  SSL_set_accept_state(ssl_s);

  /* Alternately advance each side; SSL writes handshake bytes into its BIO and
   * reads the peer's from it, so simply retrying both until each returns 1 runs
   * the exchange to completion. */
  int done_c = 0, done_s = 0;
  for (int i = 0; i < 50 && !(done_c && done_s); i++) {
    if (!done_c && SSL_do_handshake(ssl_c) == 1)
      done_c = 1;
    if (!done_s && SSL_do_handshake(ssl_s) == 1)
      done_s = 1;
  }
  if (!(done_c && done_s))
    return die("handshake did not complete");

  /* One application record each way must round-trip through the cipher. */
  const char c2s[] = "ping from client";
  const char s2c[] = "pong from server";
  char buf[64];

  if (SSL_write(ssl_c, c2s, sizeof(c2s)) != (int)sizeof(c2s))
    return die("client SSL_write");
  if (SSL_read(ssl_s, buf, sizeof(buf)) != (int)sizeof(c2s) ||
      memcmp(buf, c2s, sizeof(c2s)) != 0)
    return die("server SSL_read mismatch");

  if (SSL_write(ssl_s, s2c, sizeof(s2c)) != (int)sizeof(s2c))
    return die("server SSL_write");
  if (SSL_read(ssl_c, buf, sizeof(buf)) != (int)sizeof(s2c) ||
      memcmp(buf, s2c, sizeof(s2c)) != 0)
    return die("client SSL_read mismatch");

  printf("negotiated %s\n", SSL_get_version(ssl_c));
  printf("handshake ok\n");

  SSL_free(ssl_c);
  SSL_free(ssl_s);
  SSL_CTX_free(cctx);
  SSL_CTX_free(sctx);
  X509_free(cert);
  EVP_PKEY_free(key);
  return 0;
}
