export function closed_input() {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

export function console_output() {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      process.stderr.write(chunk);
    },
  });
}

export async function collect(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function pattern_bytes(length: number) {
  const result = new Uint8Array(length);
  for (let index = 0; index < result.length; index++) {
    result[index] = index & 0xff;
  }
  return result;
}

export async function connect_with_retry<T>(connect: () => Promise<T>) {
  let failure: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await connect();
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("guest listener did not become ready", { cause: failure });
}
