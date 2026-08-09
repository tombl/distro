#include <curses.h>
#include <term.h>
#include <stdio.h>
#include <string.h>

/* Set up each terminal by name against the shipped terminfo database and read
 * back capabilities. cursor is 0 for terminals (dumb) that have no cursor
 * addressing, so only setupterm() itself is required to succeed. */
static int check(const char *termname, int cursor)
{
	int err = 0;
	if (setupterm((char *)termname, 1, &err) != OK) {
		printf("FAIL setupterm %s err=%d\n", termname, err);
		return 1;
	}

	int cols = tigetnum("cols");
	if (cols <= 0) {
		printf("FAIL %s cols=%d\n", termname, cols);
		return 1;
	}

	if (cursor) {
		const char *clear = tigetstr("clear");
		const char *cup = tigetstr("cup");
		if (clear == (char *)-1 || clear == NULL) {
			printf("FAIL %s missing clear\n", termname);
			return 1;
		}
		if (cup == (char *)-1 || cup == NULL) {
			printf("FAIL %s missing cup\n", termname);
			return 1;
		}
	}

	printf("OK %s cols=%d\n", termname, cols);
	return 0;
}

int main(void)
{
	int bad = 0;
	bad |= check("linux", 1);
	bad |= check("vt100", 1);
	bad |= check("xterm", 1);
	bad |= check("xterm-256color", 1);
	bad |= check("screen", 1);
	bad |= check("dumb", 0);
	if (bad)
		printf("NCURSES-TEST-FAIL\n");
	else
		printf("NCURSES-TEST-PASS\n");
	return bad;
}
