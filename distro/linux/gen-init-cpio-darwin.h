/* Darwin has large-file opens by default and no copy_file_range(). */
#ifndef O_LARGEFILE
#define O_LARGEFILE 0
#endif

/* gen_init_cpio falls back to its read/write loop on a failed fast copy. */
#define copy_file_range(...) (-1)
