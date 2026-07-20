import { spawnGuest } from "@tombl/linux-guest";

async function collectProcess(child) {
  const [status, stdout, stderr] = await Promise.all([
    child.status,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr };
}

globalThis.bootSmoke = async () => {
  const guest = await spawnGuest();
  let result;
  try {
    result = await collectProcess(await guest.exec(["uname", "-a"]));
  } finally {
    guest.machine.close();
    await guest.machine.closed;
  }
  return { ...result, machineClosed: true };
};
