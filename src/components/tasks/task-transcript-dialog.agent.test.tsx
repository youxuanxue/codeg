/**
 * Which agent the transcript opens as when the task does not name one: the
 * conversation's own agent, else the folder's default, else the backend's
 * fallback. The last layer is read from the backend, never spelled here.
 */

import { act, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { WorkTask } from "@/lib/types"

import { TaskTranscriptDialog } from "./task-transcript-dialog"

const conversation = vi.hoisted(() => ({
  agent: null as string | null,
  fails: false,
}))
const fallback = vi.hoisted(() => ({ value: "cursor", fails: false }))
const folder = vi.hoisted(() => ({ default: null as string | null }))

vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => ({
    attachDelegationChild: vi.fn(),
    detachDelegationChild: vi.fn(),
  }),
}))
vi.mock("@/lib/api", () => ({
  getFolderConversation: () =>
    conversation.fails
      ? Promise.reject(new Error("transcript pruned"))
      : Promise.resolve({ summary: { agent_type: conversation.agent } }),
  workTaskEvents: () => Promise.resolve([]),
  workTaskFallbackAgent: () =>
    fallback.fails
      ? Promise.reject(new Error("no such command"))
      : Promise.resolve(fallback.value),
}))
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (selector: (s: { folders: unknown[] }) => unknown) =>
    selector({
      folders: [{ id: 1, path: "/repo", default_agent_type: folder.default }],
    }),
}))

let shownAgent: string | undefined
vi.mock("@/components/message/live-transcript-view", () => ({
  LiveTranscriptView: (props: { agentType: string }) => {
    shownAgent = props.agentType
    return <div data-testid="live-transcript" />
  },
}))
vi.mock("./task-card", () => ({ StatusChip: () => <span /> }))

function agentlessTask(): WorkTask {
  return {
    id: 9,
    folder_id: 1,
    title: "t",
    config: {},
    status: "review",
    conversation_id: 100,
    connection_id: null,
  } as unknown as WorkTask
}

async function open() {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskTranscriptDialog
        open
        onOpenChange={() => {}}
        task={agentlessTask()}
      />
    </NextIntlClientProvider>
  )
  await act(async () => {})
}

beforeEach(() => {
  conversation.agent = null
  conversation.fails = false
  fallback.value = "cursor"
  fallback.fails = false
  folder.default = null
  shownAgent = undefined
})

describe("task transcript agent", () => {
  it("opens as the conversation's own agent when it has one", async () => {
    conversation.agent = "codex"
    await open()
    expect(shownAgent).toBe("codex")
  })

  it("falls to the folder default before the backend's fallback", async () => {
    folder.default = "gemini"
    await open()
    expect(shownAgent).toBe("gemini")
  })

  it("uses whatever the backend names when nothing else does", async () => {
    // Not the agent the UI would have guessed: the answer is the backend's.
    fallback.value = "codex"
    await open()
    expect(shownAgent).toBe("codex")
  })

  it("an unreadable transcript still opens as the backend's fallback", async () => {
    conversation.fails = true
    fallback.value = "grok"
    await open()
    expect(shownAgent).toBe("grok")
  })

  it("a failed fallback read is not an unhandled rejection", async () => {
    fallback.fails = true
    const unhandled = vi.fn()
    process.on("unhandledRejection", unhandled)
    await open()
    process.off("unhandledRejection", unhandled)
    expect(unhandled).not.toHaveBeenCalled()
    expect(shownAgent).toBeUndefined()
  })
})
