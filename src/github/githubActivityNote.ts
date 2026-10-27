import type { GitHubActivityStore, GitHubRepoActivityRecord } from "@/github/GitHubActivityStore";

/**
 * Formats a note about new activity on David's watched GitHub repos for
 * the system prompt, or undefined when there's nothing new — the
 * "continuous personal profile" background section's concrete GitHub use
 * case (CLAUDE.md: "continuously watch my repos and pull relevant context
 * automatically... surface relevant things without being asked"), same
 * composition pattern as `goalProgressNote.ts`/`staleCommitmentsNote.ts`.
 *
 * Reads `GitHubActivityStore` only — never calls the GitHub API itself.
 * `pollGitHubActivity` (run on its own background interval in index.ts) is
 * what actually talks to GitHub and keeps the store's cache fresh; this
 * function just turns whatever's currently cached into prose, the same
 * division of labor `dueRemindersNote` has from the reminder-checking
 * interval that marks things notified.
 *
 * Relevance gating: deliberately NOT topic-gated the way `correctionNote`
 * is. `correctionNote` only shows up when the current message maps to
 * exactly one topic, because a stored correction is reactive guidance
 * ("how should I behave in this area") that's only useful once that area
 * actually comes up. GitHub activity is the opposite case: the whole
 * point (per CLAUDE.md's framing) is JARVIS mentioning something
 * unprompted — "I saw something that might interest you" — not waiting
 * for the user to bring up GitHub first. Gating it behind a GitHub-topic
 * message would silently defeat the one behavior this feature exists to
 * produce. So this follows `goalProgressNote`'s shape instead: always
 * considered, capped so it can't dominate the prompt, and happy to
 * contribute nothing when the cache says there's nothing new.
 */
const MAX_REPOS_IN_NOTE = 3;
const MAX_ITEMS_PER_REPO = 3;

/** The "N new commit(s): ..."/"N newly opened issue(s): ..."/"N newly opened pull request(s): ..." clauses for one repo's activity, joined with "; " — the part shared between the context-note's bulleted line and a push notification's standalone sentence (see `formatRepoActivitySummary` below), factored out so both stay in sync. */
function formatRepoActivityParts(
  newCommits: Array<{ message: string }>,
  newIssues: Array<{ number: number; title: string }>,
  newPullRequests: Array<{ number: number; title: string }>
): string {
  const parts: string[] = [];

  if (newCommits.length > 0) {
    const shown = newCommits.slice(0, MAX_ITEMS_PER_REPO);
    const omitted = newCommits.length - shown.length;
    const commitList = shown.map((c) => `"${c.message}"`).join(", ");
    parts.push(`${newCommits.length} new commit(s): ${commitList}${omitted > 0 ? ` (plus ${omitted} more not shown)` : ""}`);
  }
  if (newIssues.length > 0) {
    const shown = newIssues.slice(0, MAX_ITEMS_PER_REPO);
    const omitted = newIssues.length - shown.length;
    const issueList = shown.map((i) => `#${i.number} "${i.title}"`).join(", ");
    parts.push(`${newIssues.length} newly opened issue(s): ${issueList}${omitted > 0 ? ` (plus ${omitted} more not shown)` : ""}`);
  }
  if (newPullRequests.length > 0) {
    const shown = newPullRequests.slice(0, MAX_ITEMS_PER_REPO);
    const omitted = newPullRequests.length - shown.length;
    const prList = shown.map((p) => `#${p.number} "${p.title}"`).join(", ");
    parts.push(`${newPullRequests.length} newly opened pull request(s): ${prList}${omitted > 0 ? ` (plus ${omitted} more not shown)` : ""}`);
  }

  return parts.join("; ");
}

function formatRepoLines(
  owner: string,
  repo: string,
  newCommits: Array<{ message: string }>,
  newIssues: Array<{ number: number; title: string }>,
  newPullRequests: Array<{ number: number; title: string }>
): string {
  return `- ${owner}/${repo} — ${formatRepoActivityParts(newCommits, newIssues, newPullRequests)}`;
}

/**
 * One repo activity record as a standalone sentence, for a push
 * notification (`WatcherNotifier`) rather than a bullet in the multi-repo
 * context note `githubActivityNote` composes — see that function's own doc
 * comment for why GitHub keeps this bespoke formatter instead of the
 * generic `composeWatcherNote` news uses: category-grouped wording
 * ("3 new commit(s): ...") that predates the generic `WatchSource`
 * interface and whose exact phrasing existing tests assert.
 */
export function formatRepoActivitySummary(record: GitHubRepoActivityRecord): string {
  return `${record.owner}/${record.repo} — ${formatRepoActivityParts(record.newCommits, record.newIssues, record.newPullRequests)}`;
}

export function githubActivityNote(store: GitHubActivityStore): string | undefined {
  const activity = store.listRecentActivity();
  if (activity.length === 0) return undefined;

  const shown = activity.slice(0, MAX_REPOS_IN_NOTE);
  const omitted = activity.length - shown.length;

  const lines = shown.map((a) => formatRepoLines(a.owner, a.repo, a.newCommits, a.newIssues, a.newPullRequests));

  const omittedNote = omitted > 0 ? ` (plus ${omitted} more repo(s) with new activity not shown)` : "";
  return (
    `JARVIS has been watching ${activity.length} of the user's GitHub repo(s) that had new activity since it last checked${omittedNote} — ` +
    `feel free to mention something relevant naturally if it fits, without being asked (e.g. if it connects to what the user is currently working on):\n${lines.join("\n")}`
  );
}
