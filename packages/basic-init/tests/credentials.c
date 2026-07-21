#define _GNU_SOURCE
#include "test.h"

#include <errno.h>
#include <grp.h>
#include <sys/types.h>
#include <unistd.h>

static void check_gids(gid_t expected_real, gid_t expected_effective,
		       gid_t expected_saved)
{
	gid_t real, effective, saved;

	if (getresgid(&real, &effective, &saved) == -1)
		test_perror("getresgid");
	if (real != expected_real || effective != expected_effective ||
	    saved != expected_saved)
		test_fail("unexpected real, effective, or saved gid");
}

static void check_uids(uid_t expected_real, uid_t expected_effective,
		       uid_t expected_saved)
{
	uid_t real, effective, saved;

	if (getresuid(&real, &effective, &saved) == -1)
		test_perror("getresuid");
	if (real != expected_real || effective != expected_effective ||
	    saved != expected_saved)
		test_fail("unexpected real, effective, or saved uid");
}

static void expect_eperm(int result, const char *operation)
{
	if (result != -1 || errno != EPERM)
		test_fail(operation);
}

int main(void)
{
	const gid_t groups[] = { 10, 20, 30 };
	gid_t actual_groups[3];

	if (setgroups(3, groups) == -1)
		test_perror("setgroups");
	if (getgroups(0, NULL) != 3)
		test_fail("getgroups returned the wrong group count");
	if (getgroups(3, actual_groups) != 3)
		test_perror("getgroups");
	for (size_t i = 0; i < 3; i++) {
		if (actual_groups[i] != groups[i])
			test_fail("supplementary groups did not round-trip");
	}

	check_gids(0, 0, 0);
	if (setresgid(10, 20, 30) == -1)
		test_perror("setresgid");
	check_gids(10, 20, 30);
	if (setegid(30) == -1)
		test_perror("setegid to saved gid");
	check_gids(10, 30, 30);
	if (setregid(-1, 20) == -1)
		test_perror("setregid effective gid");
	check_gids(10, 20, 20);
	if (setresgid(0, 0, 0) == -1)
		test_perror("restore gids");
	check_gids(0, 0, 0);

	check_uids(0, 0, 0);
	if (setresuid(10, 20, 30) == -1)
		test_perror("setresuid");
	check_uids(10, 20, 30);
	if (seteuid(30) == -1)
		test_perror("seteuid to saved uid");
	check_uids(10, 30, 30);
	if (setreuid(30, 10) == -1)
		test_perror("setreuid from saved and real uids");
	check_uids(30, 10, 10);

	errno = 0;
	expect_eperm(setresuid(-1, 99, -1),
		     "unprivileged process changed to an unrelated uid");
	errno = 0;
	expect_eperm(setresgid(-1, 99, -1),
		     "unprivileged process changed to an unrelated gid");
	errno = 0;
	expect_eperm(setgroups(0, NULL),
		     "unprivileged process changed supplementary groups");

	test_pass();
}
