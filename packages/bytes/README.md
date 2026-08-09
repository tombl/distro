# `@lowland/bytes`

`@lowland/bytes` contains binary data helpers shared by Lowland packages.

This is an internal implementation package. It is published so the other
Lowland packages can share one implementation. It has no compatibility
promise. Applications must not import it directly.

Lowland releases must publish this package with the kernel and guest packages
that depend on it. All packages currently use the same version while the
release and versioning workflow is under development.
