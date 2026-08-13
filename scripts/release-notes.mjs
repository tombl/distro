#!/usr/bin/env node

import { readFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: node scripts/release-notes.mjs VERSION");
  process.exit(1);
}

const changelog = readFileSync("CHANGELOG.md", "utf8");
const escapedVersion = version.replaceAll(".", "\\.");
const heading = new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`, "m").exec(changelog);
if (!heading) throw new Error(`CHANGELOG.md has no release section for ${version}`);

const rest = changelog.slice(heading.index + heading[0].length);
const nextHeading = rest.search(/^## \[/m);
const notes = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
if (!notes) throw new Error(`CHANGELOG.md release section for ${version} is empty`);
process.stdout.write(`${notes}\n`);
