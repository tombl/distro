#include <stdio.h>
#include <string.h>
#include <zlib.h>

int main(void)
{
	char input[1024];
	for (size_t i = 0; i < sizeof(input); i++)
		input[i] = "the quick brown fox jumps over the lazy dog "[i % 44];
	uLong input_len = sizeof(input);

	Bytef compressed[2048];
	uLong compressed_len = sizeof(compressed);
	if (compress(compressed, &compressed_len, (const Bytef *)input,
		     input_len) != Z_OK) {
		fprintf(stderr, "compress failed\n");
		return 1;
	}

	if (compressed_len >= input_len) {
		fprintf(stderr, "compressed output was not smaller\n");
		return 1;
	}

	Bytef output[1024];
	uLong output_len = sizeof(output);
	if (uncompress(output, &output_len, compressed, compressed_len) !=
	    Z_OK) {
		fprintf(stderr, "uncompress failed\n");
		return 1;
	}

	if (output_len != input_len ||
	    memcmp(input, output, input_len) != 0) {
		fprintf(stderr, "roundtrip mismatch\n");
		return 1;
	}

	printf("zlib-roundtrip-ok version %s\n", zlibVersion());
	return 0;
}
