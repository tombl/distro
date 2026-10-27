#include "test.h"

#include <stddef.h>
#include <stdint.h>

/*
 * size_t, intptr_t and ptrdiff_t are long on wasm32, so their limits must be
 * too, or expressions that check their operands' types fail to compile.
 */
#define SAME_TYPE(limit, type) \
	_Static_assert(__builtin_types_compatible_p(__typeof__(limit), type), \
		       #limit " is not a " #type)

SAME_TYPE(SIZE_MAX, size_t);
SAME_TYPE(INTPTR_MIN, intptr_t);
SAME_TYPE(INTPTR_MAX, intptr_t);
SAME_TYPE(UINTPTR_MAX, uintptr_t);
SAME_TYPE(PTRDIFF_MIN, ptrdiff_t);
SAME_TYPE(PTRDIFF_MAX, ptrdiff_t);

#if SIZE_MAX != 0xffffffff || UINTPTR_MAX != 0xffffffff || PTRDIFF_MAX != 0x7fffffff
#error "pointer-sized limits are not 32-bit"
#endif

int main(void)
{
	test_pass();
}
