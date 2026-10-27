// SPDX-License-Identifier: MIT

// platform.ts starts CPU workers from ./worker.js, which tsc emits into dist.
// This stands in for it when Node runs the machine from source, as the tests
// do, and is not published.
import "./worker.ts";
