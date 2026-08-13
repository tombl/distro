import { blockDevice, vsockDevice, type Machine } from "@lowland/kernel";
import {
  getMachinePlugin,
  type MachinePlugin,
  type MachinePluginProvider,
  type MachineSetup,
} from "@lowland/kernel/plugin";
import {
  create_guest_client,
  type Exec,
  type ExecOptions,
  type FileSystem,
  type GuestClientCapabilities,
  type Mount,
  type Unmount,
} from "./client.ts";
import { platform } from "./platform.ts";
import type { ChildProcess, CommandStatus } from "./process.ts";

let agent_image: Promise<Uint8Array<ArrayBuffer>> | undefined;

function load_agent_image() {
  return (agent_image ??= platform.load_asset(new URL("../agent.img", import.meta.url)));
}

async function agent_device() {
  const bytes = await load_agent_image();
  return blockDevice({
    capacity: bytes.byteLength,
    read(offset, target) {
      const source = bytes.subarray(offset, offset + target.byteLength);
      target.set(source);
      return source.byteLength;
    },
  });
}

async function wait_for_guest(client: GuestClientCapabilities, machine: Machine) {
  let machine_ended = false;
  const ended = machine.closed.then(
    () => {
      machine_ended = true;
      throw new Error("machine closed before guest agent became ready");
    },
    (error) => {
      machine_ended = true;
      throw error;
    },
  );

  const deadline = performance.now() + 30_000;
  let failure: unknown;
  do {
    try {
      await Promise.race([client.ping(1000), ended]);
      return;
    } catch (error) {
      if (machine_ended) throw error;
      failure = error;
    }
    await Promise.race([new Promise((resolve) => setTimeout(resolve, 25)), ended]);
  } while (performance.now() < deadline);
  throw new Error("guest agent did not become ready", { cause: failure });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The collected result of a guest command. Nonzero exit status does not reject `run()`. */
export interface RunResult {
  readonly status: CommandStatus;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

/**
 * The Lowland guest-agent integration and the capabilities bound to its
 * private vsock connection. Pass this object to `bootMachine()` as a plugin,
 * then use its capabilities after `bootMachine()` resolves.
 */
export interface GuestAgent extends MachinePluginProvider {
  readonly fs: FileSystem;
  /** Starts a process with streaming standard I/O. */
  readonly exec: Exec;
  /** Runs a process and collects its status, stdout, and stderr. */
  run(argv: readonly string[], options?: ExecOptions): Promise<RunResult>;
  readonly mount: Mount;
  readonly unmount: Unmount;
}

const readiness = new WeakMap<GuestAgent, (machine: Machine) => Promise<void>>();
const machines_with_agent = new WeakSet<MachineSetup>();

/** @internal Dependency hook for guest integrations whose booted work requires the agent. */
export function wait_for_agent(agent: GuestAgent, machine: Machine): Promise<void> {
  const wait = readiness.get(agent);
  if (!wait) throw new TypeError("guest agent was not created by guestAgent()");
  return wait(machine);
}

/**
 * Creates a one-machine guest-agent integration. The plugin contributes the
 * GPT-wrapped agent EROFS, its vsock transport, and its boot arguments. The
 * partition label makes discovery independent of virtio device ordering. The
 * plugin does not finish booting until the agent is ready to accept requests.
 */
export function guestAgent(): GuestAgent {
  const vsock = vsockDevice();
  const client = create_guest_client(vsock);
  let configured = false;
  let attached_machine: Machine | undefined;
  let ready: Promise<void> | undefined;

  const wait = (machine: Machine) => {
    if (!configured)
      return Promise.reject(new Error("guest agent is not attached to this machine"));
    if (attached_machine && attached_machine !== machine) {
      return Promise.reject(new Error("guest agent is attached to a different machine"));
    }
    attached_machine = machine;
    return (ready ??= wait_for_guest(client, machine));
  };

  const plugin: MachinePlugin = {
    async configure(setup) {
      if (configured) throw new Error("guest agent is already attached to a machine");
      if (machines_with_agent.has(setup)) {
        throw new Error("a machine supports one guest agent");
      }
      configured = true;
      machines_with_agent.add(setup);

      // Register the vsock before loading the packaged asset so configuration
      // cleanup owns it even when loading the EROFS fails.
      setup.devices.add(vsock);
      setup.devices.add(await agent_device());
      setup.args.add(
        "root=PARTLABEL=LOWLAND_AGENT",
        "rootfstype=erofs",
        "ro",
        "rootwait",
        "init=/init",
      );
    },
    async booted(machine) {
      await wait(machine);
    },
  };

  const agent: GuestAgent = {
    fs: client.fs,
    exec: client.exec,
    mount: client.mount,
    unmount: client.unmount,
    async run(argv, options) {
      const child: ChildProcess = await client.exec(argv, options);
      const [status, stdout, stderr] = await Promise.all([
        child.status,
        collect(child.stdout),
        collect(child.stderr),
        child.stdin.close(),
      ]);
      return { status, stdout, stderr };
    },
    [getMachinePlugin]() {
      return plugin;
    },
  };
  readiness.set(agent, wait);
  return agent;
}
