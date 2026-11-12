import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { useState, type ReactElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"

const branchesMock = vi.fn()

vi.mock("@/lib/api", () => ({
  gitListAllBranches: (...args: unknown[]) => branchesMock(...args),
}))

import { BranchPicker } from "./branch-picker"

function withIntl(ui: ReactElement) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

/** The picker holding its own value, as a real caller does. */
function ControlledPicker({
  initial,
  spy,
}: {
  initial: string
  spy: (branch: string, isRemote: boolean) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <BranchPicker
      folderPath="/repo"
      value={value}
      onChange={(branch, isRemote) => {
        spy(branch, isRemote)
        setValue(branch)
      }}
      placeholder="(default branch)"
      defaultLabel="Default branch"
      title="Branch"
      allowRemote={false}
    />
  )
}

const trigger = () => screen.getByRole("button", { name: "Branch" })

beforeEach(() => {
  branchesMock.mockReset().mockResolvedValue({
    local: ["main", "feature"],
    remote: [],
    worktree_branches: [],
    main_worktree_branch: null,
  })
})

describe("BranchPicker", () => {
  it("shows the caller's placeholder while nothing is picked, and reads no branch list until opened", async () => {
    render(withIntl(<ControlledPicker initial="" spy={vi.fn()} />))

    expect(trigger()).toHaveTextContent(/^\(default branch\)$/)
    expect(branchesMock).not.toHaveBeenCalled()
  })

  it("lists the caller's default entry first, marked while it is the pick", async () => {
    const user = userEvent.setup()
    render(withIntl(<ControlledPicker initial="" spy={vi.fn()} />))

    await user.click(trigger())

    const entry = await screen.findByRole("option", { name: "Default branch" })
    expect(entry.querySelector("svg.lucide-check")).not.toBeNull()
    expect(screen.getByRole("option", { name: "main" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "feature" })).toBeInTheDocument()
  })

  it("a picked branch shows by name, and picking the default returns to the placeholder", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(withIntl(<ControlledPicker initial="feature" spy={onChange} />))

    expect(trigger()).toHaveTextContent(/^feature$/)

    await user.click(trigger())
    await user.click(
      await screen.findByRole("option", { name: "Default branch" })
    )

    expect(onChange).toHaveBeenCalledWith("", false)
    await waitFor(() =>
      expect(trigger()).toHaveTextContent(/^\(default branch\)$/)
    )
  })

  it("offers a name that is not a known branch, so a branch not created yet can be typed", async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(withIntl(<ControlledPicker initial="" spy={onChange} />))

    await user.click(trigger())
    await screen.findByRole("option", { name: "Default branch" })
    await user.type(
      screen.getByPlaceholderText("Search branches…"),
      "release/9"
    )
    await user.click(await screen.findByText('Use "release/9"'))

    expect(onChange).toHaveBeenCalledWith("release/9", false)
  })

  it("does not offer a typed name that already is a branch", async () => {
    const user = userEvent.setup()
    render(withIntl(<ControlledPicker initial="" spy={vi.fn()} />))

    await user.click(trigger())
    await screen.findByRole("option", { name: "Default branch" })
    await user.type(screen.getByPlaceholderText("Search branches…"), "main")

    expect(screen.queryByText('Use "main"')).toBeNull()
  })
})
