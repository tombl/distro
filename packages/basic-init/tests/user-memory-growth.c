#include "test.h"

#include <stdint.h>
#include <stdlib.h>

enum {
	page_size = 64 * 1024,
	second_size = 8 * 1024 * 1024,
};

extern char __heap_end;

static void check_bytes(const unsigned char *bytes, size_t length,
			unsigned char expected)
{
	for (size_t i = 0; i < length; i++)
		if (bytes[i] != expected)
			test_fail("malloc contents changed across memory growth");
}

int main(void)
{
	size_t initial_pages = __builtin_wasm_memory_size(0);
	uintptr_t heap_end = (uintptr_t)&__heap_end;
	size_t module_minimum_pages = (heap_end + page_size - 1) / page_size;
	size_t initial_headroom;
	size_t first_size;
	unsigned char *first;
	size_t first_pages;
	unsigned char *second;

	if (initial_pages != module_minimum_pages)
		test_fail("exec did not start at the module memory minimum");
	initial_headroom = initial_pages * page_size - heap_end;
	first_size = initial_headroom + page_size;
	if (first_size < initial_headroom)
		test_fail("initial user memory headroom overflowed");
	first = malloc(first_size);

	if (!first)
		test_perror("first malloc");
	memset(first, 0x5a, first_size);
	first_pages = __builtin_wasm_memory_size(0);
	if (first_pages <= initial_pages)
		test_fail("malloc did not grow user memory");

	second = malloc(second_size);
	if (!second)
		test_perror("second malloc");
	memset(second, 0xa5, second_size);
	if (__builtin_wasm_memory_size(0) <= first_pages)
		test_fail("second malloc did not grow user memory");

	check_bytes(first, first_size, 0x5a);
	check_bytes(second, second_size, 0xa5);
	free(second);
	free(first);
	test_pass();
}
