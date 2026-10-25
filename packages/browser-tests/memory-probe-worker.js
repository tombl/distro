// Counts how many more process-sized memories this tab can reserve, the same
// shared 4 GiB-maximum shape the kernel gives every guest process, and drops
// them all again. Browsers cap these reservations per tab, so the count goes
// down by however many each live guest process holds.
onmessage = ({ data: { limit } }) => {
  const memories = [];
  try {
    while (memories.length < limit) {
      memories.push(new WebAssembly.Memory({ initial: 1, maximum: 65536, shared: true }));
    }
  } catch {
    // RangeError on Chromium and WebKit; Firefox throws a bare string.
  }
  postMessage(memories.length);
};
