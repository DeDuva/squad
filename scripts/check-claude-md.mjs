#!/usr/bin/env node
// Fail if CLAUDE.md points at a path in this repository that no longer exists.
//
// CLAUDE.md names the file that carries each fork-specific fact — where the ADP recorder
// lives, which packages are ours, which plan is in-tree. A rename turns that from guidance
// into a wrong map, silently, and the cost is paid by whoever trusts it next.
//
// What it checks: every backticked token in CLAUDE.md that looks like a repo-relative path
// and whose first segment is a tracked top-level entry must itself be tracked. Tokens
// rooted anywhere else — github.com/…, ~/.config, another repository's layout — are
// references outside this tree and are left alone, as are paths git deliberately ignores.
//
// Node rather than a shell script because this repo is cross-platform and its scripts/ are
// already .mjs; sibling repos run the same logic as scripts/check-claude-md.sh.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (args) => execFileSync("git", args, { encoding: "utf8" });
const root = git(["rev-parse", "--show-toplevel"]).trim();
process.chdir(root);

const tracked = new Set(git(["ls-files"]).split("\n").filter(Boolean));
const topLevel = new Set([...tracked].map((p) => p.split("/")[0]));

const isIgnored = (p) => {
	try {
		execFileSync("git", ["check-ignore", "-q", "--", p], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};

const source = readFileSync("CLAUDE.md", "utf8");
const refs = new Set(
	[...source.matchAll(/`([^`\n]+)`/g)]
		.map((m) => m[1])
		.filter((t) => t.includes("/"))
		.filter((t) => !/[\s<>*$=~()|]/.test(t))
		.filter((t) => !t.includes("://"))
		.filter((t) => !/^[/@-]/.test(t)),
);

const missing = [];
for (const ref of refs) {
	if (!topLevel.has(ref.split("/")[0])) continue; // a sibling project's path, not ours
	if (isIgnored(ref)) continue; // deliberately untracked, e.g. .claude/settings.local.json

	const clean = ref.replace(/\/$/, "");
	const exists = tracked.has(clean) || [...tracked].some((p) => p.startsWith(`${clean}/`));
	if (!exists) missing.push(ref);
}

if (missing.length > 0) {
	for (const ref of missing.sort()) {
		console.error(`check-claude-md: CLAUDE.md references a path that does not exist: ${ref}`);
	}
	console.error("");
	console.error("Either the path moved and CLAUDE.md needs updating, or the reference was a typo.");
	process.exit(1);
}

console.log("check-claude-md: every repository path in CLAUDE.md resolves.");
