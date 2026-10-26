# `lowland`

`lowland` is the Lowland command line.

## Usage

```sh
npx lowland build --package busybox --package curl \
  --file ./build/app:/usr/local/bin/app:0755 \
  --output app.erofs
```

`lowland build` builds a system image from apk packages and host files. It
takes the same options as `buildImage()` from `@lowland/image/build`, as
flags:

- `-p`, `--package <name|path>` installs a package by name, or from a local
  `.apk` file. Repeat it for each package.
- `-f`, `--file <host:guest[:mode]>` copies a host file or directory into the
  image, with an optional octal mode.
- `-l`, `--link <guest=target>` creates a symbolic link.
- `--format` is `erofs` (the default) or `ext4`.
- `--compression` is `deflate` (the default), `lzma`, or `none`, and applies
  to EROFS only.
- `--label` sets the filesystem label, `LOWLAND_ROOT` by default.
- `--size` sets the image size, such as `64M`. It defaults to `256M`.
- `-o`, `--output <file>` is the image file to write.

Run `npx lowland build --help` for a summary.

## License

MIT
