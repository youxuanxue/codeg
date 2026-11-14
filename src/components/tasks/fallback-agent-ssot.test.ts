import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// The agent an agent-less task runs with is decided by the backend
// (`AgentType::FALLBACK`) and read through `workTaskFallbackAgent`. A second
// copy in the UI is how the editor once showed Claude Code while the engine
// launched something else, so no task source may spell a built-in agent as a
// default. Comparing against one (`agentType === "codex"`) is fine.
const TASKS_DIR = __dirname
const SOURCE = /\.(ts|tsx)$/
const TEST = /\.test\.(ts|tsx)$/
const AGENT =
  '"(?:claude_code|codex|open_code|gemini|cursor|grok|kiro|trae|qoder)"'
const DEFAULTS = [
  // `x ?? "cursor"`: a value filled in when nothing was chosen.
  new RegExp(`\\?\\?\\s*${AGENT}`),
  // `useState<AgentType>("cursor")`: an initial value.
  new RegExp(`useState<AgentType>\\(\\s*${AGENT}`),
]

const isHardcodedDefault = (source: string) =>
  DEFAULTS.some((pattern) => pattern.test(source))

describe("the fallback agent has one home", () => {
  it("no task source hardcodes an agent as a default", () => {
    const offenders = readdirSync(TASKS_DIR)
      .filter((f) => SOURCE.test(f) && !TEST.test(f))
      .filter((f) =>
        isHardcodedDefault(readFileSync(join(TASKS_DIR, f), "utf8"))
      )
    expect(offenders).toEqual([])
  })

  it("the rules catch a hardcoded default and let a comparison through", () => {
    expect(isHardcodedDefault('const a = picked ?? "cursor"')).toBe(true)
    expect(isHardcodedDefault('useState<AgentType>("claude_code")')).toBe(true)
    expect(isHardcodedDefault('agentType === "codex" ? "$" : "/"')).toBe(false)
    expect(
      isHardcodedDefault("useState<AgentType>(task.agent ?? fallback)")
    ).toBe(false)
  })
})
