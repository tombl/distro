// C++ exceptions unwind through wasm EH, and the unwinds the kernel uses to
// end a process image on exit or exec are not visible to guest cleanups: on
// Linux neither runs a single destructor.
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

// Announces on a pipe when it goes out of scope.
class ScopeReporter {
public:
	explicit ScopeReporter(int fd) : fd_(fd) {}
	~ScopeReporter()
	{
		char byte = 'D';
		(void)!write(fd_, &byte, 1);
	}

private:
	int fd_;
};

static int parse_fd(const char *text)
{
	return std::stoi(text);
}

// flock(1)-style: hold a descriptor and exec a command that inherits it. The
// descriptor is released if the exec fails.
static int hold_and_exec(const char *path, const char *report)
{
	UniqueFd held(open(path, O_RDONLY));
	if (held.get() < 0)
		return 126;

	std::string fd = std::to_string(held.get());
	execl("/init", "init", "check", fd.c_str(), report, (char *)nullptr);
	return 127;
}

[[noreturn]] static void finish(int status)
{
	std::exit(status);
}

static int check_inherited(const char *held, const char *report)
{
	ScopeReporter reporter(parse_fd(report));
	finish(fcntl(parse_fd(held), F_GETFD) == -1 ? 1 : 0);
}

static int destructor_runs = 0;

struct Counted {
	~Counted() { destructor_runs++; }
};

static void throw_through_cleanup()
{
	Counted counted;
	parse_fd("not a number");
}

int main(int argc, char **argv)
{
	if (argc == 4 && std::string(argv[1]) == "hold")
		return hold_and_exec(argv[2], argv[3]);
	if (argc == 4 && std::string(argv[1]) == "check")
		return check_inherited(argv[2], argv[3]);

	try {
		throw_through_cleanup();
		test_fail("std::stoi accepted a non-number");
	} catch (const std::invalid_argument &) {
	}
	if (destructor_runs != 1)
		test_fail("unwinding skipped a destructor");

	int report[2];
	if (pipe(report) != 0)
		test_perror("pipe");
	std::string report_fd = std::to_string(report[1]);
	char *const child_argv[] = {
		const_cast<char *>("init"), const_cast<char *>("hold"),
		const_cast<char *>("/"), report_fd.data(), nullptr,
	};
	pid_t pid;
	if (posix_spawn(&pid, "/init", nullptr, nullptr, child_argv, environ) != 0)
		test_perror("posix_spawn");
	close(report[1]);

	int status;
	if (waitpid(pid, &status, 0) != pid)
		test_perror("waitpid");
	char byte;
	ssize_t reported = read(report[0], &byte, 1);
	if (!WIFEXITED(status))
		test_fail("child did not exit normally");
	if (WEXITSTATUS(status) == 1)
		test_fail("exec closed the inherited descriptor");
	if (WEXITSTATUS(status) != 0)
		test_fail("child failed to hold and exec");
	if (reported != 0)
		test_fail("exit ran a destructor");

	test_pass();
}
