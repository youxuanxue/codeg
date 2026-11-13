import { describe, expect, it } from "vitest"

import {
  randomWorktreeSlug,
  suggestedSessionWorktree,
} from "./session-worktree"

describe("suggestedSessionWorktree", () => {
  it("uses the wts directory and branch shape", () => {
    expect(
      suggestedSessionWorktree("/Users/feng/Codes/codeg", "6sjj0i")
    ).toEqual({
      branchName: "chore/6sjj0i",
      worktreePath: "/Users/feng/Codes/codeg-wt-6sjj0i",
    })
  })

  it("keeps a Windows sibling next to the repo", () => {
    expect(suggestedSessionWorktree("C:\\work\\repo", "ab12cd")).toEqual({
      branchName: "chore/ab12cd",
      worktreePath: "C:\\work\\repo-wt-ab12cd",
    })
  })

  it("falls back to a project name when the path has none", () => {
    expect(suggestedSessionWorktree("/", "ab12cd").worktreePath).toBe(
      "/project-wt-ab12cd"
    )
  })
})

describe("randomWorktreeSlug", () => {
  it("is a cc-switch slug", () => {
    const slug = randomWorktreeSlug()
    expect(slug).toMatch(/^[a-z0-9]{6}$/)
  })
})
