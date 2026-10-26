// C++ exceptions unwind through wasm EH, and the unwinds the kernel uses to
// end a process image on exit or exec are not visible to guest cleanups: on
// Linux neither runs a single destructor. Exec shows it: a cleanup would close
// a descriptor the new image inherits. Exit cannot, since the task's files are
// gone before its image halts; the kernel's unit tests cover that halt.
#include "test.h"

#include <cstdlib>
#include <stdexcept>
#include <string>
#include <fcntl.h>
#include <spawn.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

class UniqueFd {
public:
	explicit UniqueFd(int fd) : fd_(fd) {}
	UniqueFd(const UniqueFd &) = delete;
	UniqueFd &operator=(const UniqueFd &) = delete;
	~UniqueFd()
	{
		if (fd_ >= 0)
			close(fd_);
	}

	int get() const { return fd_; }

private:
	int fd_;
};

static int parse_fd(const char *text)
{
	return std::stoi(text);
}

static int destructor_runs = 0;

struct Counted {
	~Counted() { destructor_runs++; }
};

// flock(1)-style: hold a descriptor and exec a command that inherits it, from
// inside a try. The descriptor is released if the exec fails.
static int hold_and_exec(const char *path)
{
	try {
		UniqueFd held(open(path, O_RDONLY));
		if (held.get() < 0)
			return 126;

		std::string fd = std::to_string(held.get());
		execl("/init", "init", "check", fd.c_str(), (char *)nullptr);
		return 127;
	} catch (...) {
		return 125;
	}
}

// Exits from inside a try, with a destructor pending, with the status the
// parent checks for.
static int check_inherited(const char *held)
{
	try {
		Counted pending;
		std::exit(fcntl(parse_fd(held), F_GETFD) == -1 ? 1 : 0);
	} catch (...) {
		return 125;
	}
}

static void throw_through_cleanup()
{
	Counted counted;
	parse_fd("not a number");
}

int main(int argc, char **argv)
{
	if (argc == 3 && std::string(argv[1]) == "hold")
		return hold_and_exec(argv[2]);
	if (argc == 3 && std::string(argv[1]) == "check")
		return check_inherited(argv[2]);

	try {
		throw_through_cleanup();
		test_fail("std::stoi accepted a non-number");
	} catch (const std::invalid_argument &) {
	}
	if (destructor_runs != 1)
		test_fail("unwinding skipped a destructor");

	char *const child_argv[] = {
		const_cast<char *>("init"), const_cast<char *>("hold"),
		const_cast<char *>("/"), nullptr,
	};
	pid_t pid;
	if (posix_spawn(&pid, "/init", nullptr, nullptr, child_argv, environ) != 0)
		test_perror("posix_spawn");

	int status;
	if (waitpid(pid, &status, 0) != pid)
		test_perror("waitpid");
	if (!WIFEXITED(status))
		test_fail("child did not exit normally");
	if (WEXITSTATUS(status) == 1)
		test_fail("exec closed the inherited descriptor");
	if (WEXITSTATUS(status) == 125)
		test_fail("a catch intercepted exec or exit");
	if (WEXITSTATUS(status) != 0)
		test_fail("child failed to hold and exec");

	test_pass();
}
