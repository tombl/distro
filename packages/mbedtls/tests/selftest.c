/* Exercise the three things the port most needs to work on wasm32-musl:
 * a hash (SHA-256), a block cipher (AES-128), and the CTR_DRBG seeded from
 * the platform entropy source. The first two are pure computation with known
 * answers; the third is the real porting risk, since it depends on the guest
 * kernel providing getrandom()/`/dev/urandom`. Each stage prints "<name> ok"
 * on success and the program exits nonzero on any failure. */

#include <stdio.h>
#include <string.h>

#include "mbedtls/aes.h"
#include "mbedtls/ctr_drbg.h"
#include "mbedtls/entropy.h"
#include "mbedtls/sha256.h"

static int check_sha256(void) {
  /* FIPS 180-2 / NIST example: SHA-256("abc"). */
  static const unsigned char input[] = { 'a', 'b', 'c' };
  static const unsigned char expected[32] = {
    0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea,
    0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
    0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c,
    0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad,
  };
  unsigned char output[32];

  if (mbedtls_sha256(input, sizeof(input), output, 0) != 0) {
    printf("sha256 FAIL: computation error\n");
    return -1;
  }
  if (memcmp(output, expected, sizeof(expected)) != 0) {
    printf("sha256 FAIL: wrong digest\n");
    return -1;
  }
  printf("sha256 ok\n");
  return 0;
}

static int check_aes(void) {
  /* FIPS-197 AES-128 ECB known-answer vector. */
  static const unsigned char key[16] = {
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
    0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
  };
  static const unsigned char plain[16] = {
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
    0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
  };
  static const unsigned char expected[16] = {
    0x69, 0xc4, 0xe0, 0xd8, 0x6a, 0x7b, 0x04, 0x30,
    0xd8, 0xcd, 0xb7, 0x80, 0x70, 0xb4, 0xc5, 0x5a,
  };
  unsigned char output[16];
  mbedtls_aes_context aes;
  int rc = -1;

  mbedtls_aes_init(&aes);
  if (mbedtls_aes_setkey_enc(&aes, key, 128) != 0) {
    printf("aes FAIL: setkey error\n");
    goto out;
  }
  if (mbedtls_aes_crypt_ecb(&aes, MBEDTLS_AES_ENCRYPT, plain, output) != 0) {
    printf("aes FAIL: encrypt error\n");
    goto out;
  }
  if (memcmp(output, expected, sizeof(expected)) != 0) {
    printf("aes FAIL: wrong ciphertext\n");
    goto out;
  }
  printf("aes ok\n");
  rc = 0;
out:
  mbedtls_aes_free(&aes);
  return rc;
}

static int check_drbg(void) {
  static const char pers[] = "wasm-mbedtls-selftest";
  unsigned char a[32];
  unsigned char b[32];
  mbedtls_entropy_context entropy;
  mbedtls_ctr_drbg_context ctr_drbg;
  int rc = -1;
  int ret;

  mbedtls_entropy_init(&entropy);
  mbedtls_ctr_drbg_init(&ctr_drbg);

  ret = mbedtls_ctr_drbg_seed(&ctr_drbg, mbedtls_entropy_func, &entropy,
                              (const unsigned char *)pers, strlen(pers));
  if (ret != 0) {
    /* Negative mbedtls error code; -0x003C is ENTROPY_SOURCE_FAILED. */
    printf("entropy FAIL: ctr_drbg_seed returned -0x%04X\n", (unsigned)-ret);
    goto out;
  }

  if (mbedtls_ctr_drbg_random(&ctr_drbg, a, sizeof(a)) != 0 ||
      mbedtls_ctr_drbg_random(&ctr_drbg, b, sizeof(b)) != 0) {
    printf("entropy FAIL: ctr_drbg_random error\n");
    goto out;
  }

  /* Two draws must differ, and neither may be all-zero. */
  if (memcmp(a, b, sizeof(a)) == 0) {
    printf("entropy FAIL: two draws identical\n");
    goto out;
  }
  {
    unsigned char acc = 0;
    for (size_t i = 0; i < sizeof(a); i++)
      acc |= a[i];
    if (acc == 0) {
      printf("entropy FAIL: all-zero output\n");
      goto out;
    }
  }

  printf("entropy ok\n");
  rc = 0;
out:
  mbedtls_ctr_drbg_free(&ctr_drbg);
  mbedtls_entropy_free(&entropy);
  return rc;
}

int main(void) {
  if (check_sha256() != 0)
    return 1;
  if (check_aes() != 0)
    return 1;
  if (check_drbg() != 0)
    return 1;
  printf("all-ok\n");
  return 0;
}
