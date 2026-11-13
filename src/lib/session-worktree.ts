import { fsBaseName, siblingFsPath } from "@/lib/path-utils"

const SLUG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"

/**
 * Suggested branch and directory for the "new worktree" dialog.
 *
 * Matches `wts`: sibling directory `{repo}-wt-{slug}`, branch `chore/{slug}`.
 * cc-switch's session cleanup only treats a sibling whose name starts with
 * `{repo}-wt-`, `{repo}-main-`, or `{repo}-task-` as a managed worktree, and
 * the slug after that marker must be a short `[A-Za-z0-9][A-Za-z0-9._-]*`.
 * The old `{repo}-{currentBranch}-{random}` / `cv-{branch}-{random}` pair
 * missed that whenever the current branch was not `main` or `task`.
 */
export function suggestedSessionWorktree(
  folderPath: string,
  slug: string = randomWorktreeSlug()
): { branchName: string; worktreePath: string } {
  const folderName = fsBaseName(folderPath) || "project"
  return {
    branchName: `chore/${slug}`,
    worktreePath: siblingFsPath(folderPath, `${folderName}-wt-${slug}`),
  }
}

export function randomWorktreeSlug(length = 6): string {
  let slug = ""
  for (let i = 0; i < length; i++) {
    slug += SLUG_CHARS[Math.floor(Math.random() * SLUG_CHARS.length)]
  }
  return slug
}
