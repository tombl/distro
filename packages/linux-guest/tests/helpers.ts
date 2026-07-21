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

// UDP is unreliable and the guest binds its listening socket asynchronously
// after exec returns: a datagram that reaches the guest before bind() draws an
// ICMP port-unreachable and is silently dropped. There is no retransmission in
// the datagram path, so resend until the guest echoes a reply, mirroring the
// connect_with_retry loop the TCP tests use.
export async function read_with_retransmit<T>(
  reader: ReadableStreamDefaultReader<T>,
  send: () => Promise<void>,
) {
  const pending = reader.read();
  const timed_out = Symbol("timed out");
  for (let attempt = 0; attempt < 100; attempt++) {
    await send();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<typeof timed_out>((resolve) => {
      timer = setTimeout(() => resolve(timed_out), 25);
    });
    const result = await Promise.race([pending, deadline]);
    clearTimeout(timer!);
    if (result !== timed_out) return result;
  }
  throw new Error("guest did not echo the datagram");
}
