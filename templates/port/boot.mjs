import { Linux } from "lowland";

await using linux = await Linux.create({ image: process.argv[2] ?? "result" });
const { status, stdout, stderr } = await linux.run(["hello"]);
process.stdout.write(stdout);
process.stderr.write(stderr);
process.exitCode = status.success ? 0 : 1;
