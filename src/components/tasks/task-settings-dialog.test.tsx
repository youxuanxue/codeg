import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { WorkTaskFolderSettings } from "@/lib/types"

const getMock = vi.fn()
const getOwnMock = vi.fn()
const setMock = vi.fn().mockResolvedValue(undefined)
const deleteMock = vi.fn().mockResolvedValue(undefined)
const commandsMock = vi.fn()

vi.mock("@/lib/api", () => ({
  workTaskSettingsGet: (...args: unknown[]) => getMock(...args),
  workTaskSettingsGetOwn: (...args: unknown[]) => getOwnMock(...args),
  workTaskSettingsSet: (...args: unknown[]) => setMock(...args),
  workTaskSettingsDelete: (...args: unknown[]) => deleteMock(...args),
  listFolderCommands: (...args: unknown[]) => commandsMock(...args),
  workTaskFallbackAgent: () => Promise.resolve("cursor"),
}))

// The agent surface probes a live CLI; none of it is under test here.
vi.mock("@/components/chat/agent-selector", () => ({
  AgentSelector: () => <div data-testid="agent-selector" />,
}))
vi.mock("@/components/automations/agent-config-section", () => ({
  AgentConfigSection: () => <div data-testid="agent-config" />,
  effectiveSelections: (
    _snapshot: unknown,
    modeId: string | null,
    configValues: Record<string, string>
  ) => ({ mode_id: modeId, config_values: configValues }),
  snapshotLabels: () => ({}),
  useBooleanOptionLabels: () => ({ on: "On", off: "Off" }),
}))
vi.mock("@/components/automations/use-agent-options", () => ({
  useAgentOptions: () => ({
    snapshot: null,
    loading: false,
    error: null,
    reload: vi.fn(),
    ensure: () => Promise.resolve(null),
  }),
}))
vi.mock("@/lib/custom-agents", () => ({
  getAgentLabel: (agent: string) => agent,
}))
vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    folders: [
      {
        id: 1,
        name: "proj",
        alias: null,
        parent_id: null,
        kind: "regular",
        path: "/tmp/proj",
        default_agent_type: "claude_code",
      },
    ],
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  useStore.getState = () => state
  return { useAppWorkspaceStore: useStore }
})

import { TaskSettingsDialog } from "./task-settings-dialog"

function settings(
  overrides?: Partial<WorkTaskFolderSettings>
): WorkTaskFolderSettings {
  return {
    default_agent_type: null,
    mode_id: null,
    config_values: {},
    auto_process: false,
    max_concurrent: 2,
    merge_strategy: "squash",
    auto_merge: false,
    delete_worktree_default: true,
    auto_compact_percent: 0,
    ...overrides,
  }
}

function renderDialog(folderId: number | null) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskSettingsDialog open onOpenChange={() => {}} folderId={folderId} />
    </NextIntlClientProvider>
  )
}

/** Wait for the initial load: the tabs only render once the settings land. */
async function loadSettings() {
  await screen.findByRole("tablist", { name: "Task settings" })
}

/**
 * Click one of the dialog's own tabs. Scoped to the top strip because the
 * Prompts tab nests a stage strip that repeats some of the same names —
 * "Merge" is both a tab up here and a launch stage down there.
 */
async function openTab(user: ReturnType<typeof userEvent.setup>, name: string) {
  const strip = screen.getByRole("tablist", { name: "Task settings" })
  await user.click(within(strip).getByRole("tab", { name }))
}

async function openPromptsTab(user: ReturnType<typeof userEvent.setup>) {
  await openTab(user, "Prompts")
}

/** Click a stage inside the Prompts tab's own strip. */
async function openStage(
  user: ReturnType<typeof userEvent.setup>,
  name: string
) {
  const strip = screen.getByRole("tablist", { name: "Prompts" })
  await user.click(within(strip).getByRole("tab", { name }))
}

function stageTab(name: string) {
  return within(screen.getByRole("tablist", { name: "Prompts" })).getByRole(
    "tab",
    { name }
  )
}

beforeEach(() => {
  getMock.mockReset().mockResolvedValue(settings())
  getOwnMock.mockReset().mockResolvedValue(settings())
  setMock.mockClear()
  deleteMock.mockClear()
  commandsMock.mockReset().mockResolvedValue([])
})

describe("TaskSettingsDialog stage prompts", () => {
  it("saves the text typed for one stage under that stage's key", async () => {
    const user = userEvent.setup()
    renderDialog(1)
    await loadSettings()

    await openPromptsTab(user)
    await openStage(user, "Merge")
    await user.type(
      screen.getByRole("textbox", { name: "Merge" }),
      "Write the commit message in Chinese."
    )
    await user.tab()

    await waitFor(() => expect(setMock).toHaveBeenCalled())
    const [, saved] = setMock.mock.calls[0] as [number, WorkTaskFolderSettings]
    expect(saved.stage_prompts).toEqual({
      merge: "Write the commit message in Chinese.",
    })
  })

  it("shows saved stage text and marks the stages that carry it", async () => {
    getOwnMock.mockResolvedValue(
      settings({
        stage_prompts: { all: "Reply in Chinese.", work: "Be brief." },
      })
    )
    const user = userEvent.setup()
    renderDialog(1)
    await loadSettings()
    await openPromptsTab(user)

    // "All stages" is selected first, so its text is the one on screen.
    expect(screen.getByRole("textbox", { name: "All stages" })).toHaveValue(
      "Reply in Chinese."
    )
    // Configured stages carry a dot; untouched ones do not.
    expect(stageTab("Retry run").querySelector(".bg-primary")).toBeNull()
    expect(stageTab("Task run").querySelector(".bg-primary")).not.toBeNull()

    await openStage(user, "Task run")
    expect(screen.getByRole("textbox", { name: "Task run" })).toHaveValue(
      "Be brief."
    )
  })

  it("gives each stage its own example placeholder", async () => {
    const user = userEvent.setup()
    renderDialog(1)
    await loadSettings()
    await openPromptsTab(user)

    const placeholders: string[] = []
    for (const stage of [
      "All stages",
      "Task run",
      "Retry run",
      "Follow-up",
      "Merge",
    ]) {
      await openStage(user, stage)
      const box = screen.getByRole("textbox", { name: stage })
      placeholders.push(box.getAttribute("placeholder") ?? "")
    }

    expect(placeholders.every((p) => p.length > 0)).toBe(true)
    expect(new Set(placeholders).size).toBe(placeholders.length)
  })

  it("drops stages whose text is only whitespace", async () => {
    const user = userEvent.setup()
    renderDialog(1)
    await loadSettings()

    await openPromptsTab(user)
    await user.type(screen.getByRole("textbox", { name: "All stages" }), "   ")
    await user.tab()

    await waitFor(() => expect(setMock).toHaveBeenCalled())
    const [, saved] = setMock.mock.calls[0] as [number, WorkTaskFolderSettings]
    expect(saved.stage_prompts).toEqual({})
  })
})

describe("TaskSettingsDialog merge tab", () => {
  it("keeps the landing options together, apart from the worktree ones", async () => {
    const user = userEvent.setup()
    renderDialog(1)
    await loadSettings()

    await openTab(user, "Merge")
    expect(
      screen.getByRole("radiogroup", { name: "Default merge strategy" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("switch", { name: "Merge automatically" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("switch", { name: "Delete the worktree after merging" })
    ).toBeInTheDocument()
    // Where the worktree is made and what runs in it is the other tab's job.
    expect(
      screen.queryByRole("textbox", { name: "Worktree location" })
    ).toBeNull()

    await openTab(user, "Worktree")
    expect(
      screen.getByRole("textbox", { name: "Worktree location" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("textbox", { name: "Worktree init command" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("textbox", { name: "Preflight command" })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("radiogroup", { name: "Default merge strategy" })
    ).toBeNull()
  })

  it("saves the auto-merge switch alongside the other landing options", async () => {
    const user = userEvent.setup()
    renderDialog(1)
    await loadSettings()

    await openTab(user, "Merge")
    const toggle = screen.getByRole("switch", { name: "Merge automatically" })
    expect(toggle).toHaveAttribute("data-state", "unchecked")
    await user.click(toggle)
    await user.tab()

    await waitFor(() => expect(setMock).toHaveBeenCalled())
    const [, saved] = setMock.mock.calls[0] as [number, WorkTaskFolderSettings]
    expect(saved.auto_merge).toBe(true)
    expect(saved.delete_worktree_default).toBe(true)
  })

  it("seeds the auto-merge switch from the stored row", async () => {
    getOwnMock.mockResolvedValue(settings({ auto_merge: true }))
    const user = userEvent.setup()
    renderDialog(1)
    await loadSettings()

    await openTab(user, "Merge")
    expect(
      screen.getByRole("switch", { name: "Merge automatically" })
    ).toHaveAttribute("data-state", "checked")
  })
})

describe("TaskSettingsDialog worktree tab", () => {
  it("carries a legacy preflight reference over as the command it names", async () => {
    getOwnMock.mockResolvedValue(settings({ preflight_command_id: 7 }))
    commandsMock.mockResolvedValue([
      {
        id: 7,
        folder_id: 1,
        name: "test",
        command: "pnpm test",
        sort_order: 0,
        run_local: false,
        created_at: "",
        updated_at: "",
      },
    ])
    const user = userEvent.setup()
    renderDialog(1)
    await loadSettings()
    await openTab(user, "Worktree")
    expect(
      screen.getByRole("textbox", { name: "Preflight command" })
    ).toHaveValue("pnpm test")
  })

  it("doesn't carry over a legacy reference to a command run on the desktop", async () => {
    // The preflight runs on the folder's host.
    getOwnMock.mockResolvedValue(settings({ preflight_command_id: 7 }))
    commandsMock.mockResolvedValue([
      {
        id: 7,
        folder_id: 1,
        name: "zed",
        command: "zed .",
        sort_order: 0,
        run_local: true,
        created_at: "",
        updated_at: "",
      },
    ])
    const user = userEvent.setup()
    renderDialog(1)
    await loadSettings()
    await openTab(user, "Worktree")
    expect(
      screen.getByRole("textbox", { name: "Preflight command" })
    ).toHaveValue("")
  })

  it("saves a chosen worktree directory, and blanks it back to the default", async () => {
    const user = userEvent.setup()
    renderDialog(1)
    await loadSettings()

    await openTab(user, "Worktree")
    const box = screen.getByRole("textbox", { name: "Worktree location" })
    expect(box).toHaveValue("")
    await user.type(box, "  ~/codeg-worktrees  ")
    await user.tab()

    await waitFor(() => expect(setMock).toHaveBeenCalled())
    const [, saved] = setMock.mock.calls[0] as [number, WorkTaskFolderSettings]
    // Trimmed: a stray space would become part of the directory name.
    expect(saved.worktree_root).toBe("~/codeg-worktrees")

    // Clearing the box is how you go back to "next to the project folder",
    // which the engine reads off an absent value — not an empty one.
    setMock.mockClear()
    await user.clear(box)
    await user.tab()
    await waitFor(() => expect(setMock).toHaveBeenCalled())
    const [, cleared] = setMock.mock.calls[0] as [
      number,
      WorkTaskFolderSettings,
    ]
    expect(cleared.worktree_root).toBeNull()
  })

  it("seeds the worktree directory from the stored row", async () => {
    getOwnMock.mockResolvedValue(settings({ worktree_root: "/var/trees" }))
    const user = userEvent.setup()
    renderDialog(1)
    await loadSettings()

    await openTab(user, "Worktree")
    expect(
      screen.getByRole("textbox", { name: "Worktree location" })
    ).toHaveValue("/var/trees")
  })
})

describe("TaskSettingsDialog auto-compact", () => {
  it("saves the threshold and the command, and seeds both back", async () => {
    const user = userEvent.setup()
    renderDialog(1)
    await loadSettings()

    const box = screen.getByRole("textbox", { name: "Auto-compact threshold" })
    expect(box).toHaveValue("0")
    await user.clear(box)
    await user.type(box, "80")
    await user.type(
      screen.getByRole("textbox", { name: "Compact command" }),
      "  /compress  "
    )
    await user.tab()

    // Leaving the threshold box already saved once; the last write is the
    // one that carries both values.
    await waitFor(() => {
      const last = setMock.mock.calls[setMock.mock.calls.length - 1] as
        | [number, WorkTaskFolderSettings]
        | undefined
      expect(last?.[1].compact_command).toBe("/compress")
    })
    const [, saved] = setMock.mock.calls[setMock.mock.calls.length - 1] as [
      number,
      WorkTaskFolderSettings,
    ]
    expect(saved.auto_compact_percent).toBe(80)
  })

  it("seeds the threshold and the command from the stored row", async () => {
    getOwnMock.mockResolvedValue(
      settings({ auto_compact_percent: 80, compact_command: "/compress" })
    )
    renderDialog(1)
    await loadSettings()

    expect(
      screen.getByRole("textbox", { name: "Auto-compact threshold" })
    ).toHaveValue("80")
    expect(
      screen.getByRole("textbox", { name: "Compact command" })
    ).toHaveValue("/compress")
  })

  it("reads a percentage it cannot honour as off", async () => {
    const user = userEvent.setup()
    renderDialog(1)
    await loadSettings()

    const box = screen.getByRole("textbox", { name: "Auto-compact threshold" })
    // Above 100 there is no occupancy that could ever reach it — storing it
    // would look enabled while behaving exactly like off.
    await user.clear(box)
    await user.type(box, "120")
    await user.tab()

    await waitFor(() => expect(setMock).toHaveBeenCalled())
    const [, saved] = setMock.mock.calls[0] as [number, WorkTaskFolderSettings]
    expect(saved.auto_compact_percent).toBe(0)

    // And an emptied box is off too, rather than NaN.
    setMock.mockClear()
    await user.clear(box)
    await user.tab()
    await waitFor(() => expect(setMock).toHaveBeenCalled())
    const [, blanked] = setMock.mock.calls[0] as [
      number,
      WorkTaskFolderSettings,
    ]
    expect(blanked.auto_compact_percent).toBe(0)
    expect(blanked.compact_command).toBeNull()
  })
})

describe("TaskSettingsDialog scope", () => {
  it("seeds a folder with no row of its own from the global defaults", async () => {
    getOwnMock.mockResolvedValue(null)
    getMock.mockResolvedValue(
      settings({ max_concurrent: 5, stage_prompts: { all: "From global." } })
    )
    const user = userEvent.setup()
    renderDialog(1)
    await loadSettings()

    // Following the global row: the form stays hidden until it is detached.
    expect(screen.queryByRole("tab", { name: "Prompts" })).toBeNull()
    await user.click(screen.getByRole("tab", { name: "Custom" }))
    await openPromptsTab(user)
    expect(screen.getByRole("textbox", { name: "All stages" })).toHaveValue(
      "From global."
    )

    await user.tab()
    await waitFor(() => expect(setMock).toHaveBeenCalled())
    const [, saved] = setMock.mock.calls[0] as [number, WorkTaskFolderSettings]
    expect(saved.max_concurrent).toBe(5)
    expect(saved.stage_prompts).toEqual({ all: "From global." })
    expect(deleteMock).not.toHaveBeenCalled()
  })

  it("drops the folder's own row when it is set back to the global defaults", async () => {
    const user = userEvent.setup()
    renderDialog(1)
    await loadSettings()

    await user.click(screen.getByRole("tab", { name: "Global defaults" }))
    await user.tab()

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith(1))
    expect(setMock).not.toHaveBeenCalled()
  })
})

describe("TaskSettingsDialog autosave", () => {
  it("has no Save button: a click on a switch writes at once", async () => {
    const user = userEvent.setup()
    renderDialog(1)
    await loadSettings()
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()

    await openTab(user, "Merge")
    await user.click(
      screen.getByRole("switch", { name: "Merge automatically" })
    )

    await waitFor(() => expect(setMock).toHaveBeenCalledTimes(1))
    const [folder, saved] = setMock.mock.calls[0] as [
      number,
      WorkTaskFolderSettings,
    ]
    expect(folder).toBe(1)
    expect(saved.auto_merge).toBe(true)
  })

  it("does not write while a text box is being typed in", async () => {
    const user = userEvent.setup()
    renderDialog(1)
    await loadSettings()

    await openTab(user, "Worktree")
    await user.type(
      screen.getByRole("textbox", { name: "Worktree location" }),
      "~/wt"
    )
    expect(setMock).not.toHaveBeenCalled()
    await user.tab()
    await waitFor(() => expect(setMock).toHaveBeenCalledTimes(1))
  })

  it("does not write when a box loses focus with nothing changed", async () => {
    const user = userEvent.setup()
    renderDialog(1)
    await loadSettings()

    await openTab(user, "Worktree")
    await user.click(screen.getByRole("textbox", { name: "Worktree location" }))
    await user.tab()
    await new Promise((r) => setTimeout(r, 50))
    expect(setMock).not.toHaveBeenCalled()
  })

  it("shows the stored value again when a write fails", async () => {
    setMock.mockRejectedValueOnce(new Error("disk full"))
    const user = userEvent.setup()
    renderDialog(1)
    await loadSettings()

    await openTab(user, "Merge")
    const toggle = screen.getByRole("switch", { name: "Merge automatically" })
    await user.click(toggle)

    await waitFor(() => expect(getOwnMock.mock.calls.length).toBeGreaterThan(1))
    await waitFor(() =>
      expect(
        screen.getByRole("switch", { name: "Merge automatically" })
      ).toHaveAttribute("data-state", "unchecked")
    )
  })
})
