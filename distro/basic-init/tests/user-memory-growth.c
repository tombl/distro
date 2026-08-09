#include "test.h"

#include <stdint.h>
#include <stdlib.h>

enum {
	page_size = 64 * 1024,
	small_allocation_count = 256,
	small_size = 1024,
	split_size = 1024 * 1024,
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
	size_t second_pages;
	unsigned char *small[small_allocation_count];
	unsigned char *split;

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
	second_pages = __builtin_wasm_memory_size(0);
	if (second_pages <= first_pages)
		test_fail("second malloc did not grow user memory");

	check_bytes(first, first_size, 0x5a);
	check_bytes(second, second_size, 0xa5);
	free(second);

	second = malloc(second_size);
	if (!second)
		test_perror("reused malloc");
	memset(second, 0x3c, second_size);
	if (__builtin_wasm_memory_size(0) != second_pages)
		test_fail("malloc did not reuse freed map storage");
	check_bytes(first, first_size, 0x5a);
	check_bytes(second, second_size, 0x3c);
	free(second);

	second = calloc(1, second_size);
	if (!second)
		test_perror("reused calloc");
	check_bytes(second, second_size, 0);
	if (__builtin_wasm_memory_size(0) != second_pages)
		test_fail("calloc did not reuse freed map storage");
	free(second);

	split = malloc(split_size);
	if (!split)
		test_perror("split malloc");
	memset(split, 0x6d, split_size);
	if (__builtin_wasm_memory_size(0) != second_pages)
		test_fail("malloc did not split freed map storage");
	free(split);

	second = malloc(second_size);
	if (!second)
		test_perror("coalesced malloc");
	if (__builtin_wasm_memory_size(0) != second_pages)
		test_fail("malloc did not coalesce freed map storage");
	memset(second, 0x7e, second_size);
	free(second);

	for (size_t i = 0; i < small_allocation_count; i++) {
		small[i] = malloc(small_size);
		if (!small[i])
			test_perror("small malloc from dirty map storage");
		memset(small[i], (unsigned char)i, small_size);
	}
	if (__builtin_wasm_memory_size(0) != second_pages)
		test_fail("small mallocs did not reuse dirty map storage");
	for (size_t i = 0; i < small_allocation_count; i++) {
		check_bytes(small[i], small_size, (unsigned char)i);
		free(small[i]);
	}
	check_bytes(first, first_size, 0x5a);
	free(first);
	test_pass();
}
