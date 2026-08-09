#include <stdio.h>
#include <stdlib.h>
#include <readline/readline.h>

/* Read exactly one line through readline and echo it back framed by markers.
 * When run under a pty (stdin is a tty) readline does full line editing, so a
 * fed backspace proves the editor mutated the buffer rather than passing bytes
 * through verbatim. */
int main(void)
{
	char *line = readline("PROMPT> ");
	if (line == NULL) {
		printf("\nREADLINE-EOF\n");
		return 1;
	}
	printf("\nREADLINE-GOT[%s]\n", line);
	free(line);
	return 0;
}
