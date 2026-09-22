/**
 * Regenerates CHANGELOG.md from git history on `main` — one line per
 * squash-merged PR (the "... (#123)" commit message format every PR in
 * this repo's own workflow already produces), newest first. Run this
 * after merging a PR so CHANGELOG.md stays a real, current summary
 * instead of something you have to dig `git log` for.
 *
 * Usage: bun run scripts/generate-changelog.ts
 */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const PR_COMMIT_PATTERN = /^(.+) \(#(\d+)\)$/;

const log = execSync("git log --pretty=format:%s main", { encoding: "utf-8" });
const entries = log
  .split("\n")
  .map((line) => line.match(PR_COMMIT_PATTERN))
  .filter((match): match is RegExpMatchArray => match !== null)
  .map((match) => `- ${match[1]} (#${match[2]})`);

const content = `# Changelog

Auto-generated from \`main\`'s commit history by \`scripts/generate-changelog.ts\` —
one line per merged PR, newest first. Not hand-maintained; re-run the script
after merging a PR to refresh this file.

${entries.join("\n")}
`;

writeFileSync(new URL("../CHANGELOG.md", import.meta.url), content);
console.log(`Wrote CHANGELOG.md with ${entries.length} entries.`);
