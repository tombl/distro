prefix ?= /usr/local

hello: hello.c

install: hello
	install -Dm755 hello $(DESTDIR)$(prefix)/bin/hello

.PHONY: install
