#!/usr/bin/env node

// Prints the GitHub release notes for VERSION: its CHANGELOG section and how
// to install the published packages. --unreleased previews the notes from the
// [Unreleased] section instead, for a release that has not been cut yet.

import { readFileSync } from "node:fs";
import { publishedPackages, workspaceRoot } from "./packages.mjs";

const args = process.argv.slice(2);
const unreleased = args.includes("--unreleased");
const [version, ...extra] = args.filter((arg) => arg !== "--unreleased");
if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || extra.length) {
  console.error("usage: node scripts/release-notes.mjs VERSION [--unreleased]");
  process.exit(1);
}

const changelog = readFileSync("CHANGELOG.md", "utf8");
const escapedVersion = version.replaceAll(".", "\\.");
const heading = unreleased
  ? /^## \[Unreleased\]\s*$/m.exec(changelog)
  : new RegExp(`^## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`, "m").exec(changelog);
const section = unreleased ? "[Unreleased]" : version;
if (!heading) throw new Error(`CHANGELOG.md has no release section for ${section}`);

const rest = changelog.slice(heading.index + heading[0].length);
const nextHeading = rest.search(/^## \[/m);
const notes = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
if (!notes) throw new Error(`CHANGELOG.md release section for ${section} is empty`);

const install = publishedPackages(workspaceRoot())
  .map(({ name }) => `npm install ${name}@${version}`)
  .join("\n");
process.stdout.write(`${notes}\n\n### Install\n\n\`\`\`sh\n${install}\n\`\`\`\n`);
