import { beforeEach, describe, expect, it, vi } from "vitest"

import { resolveDefaultBrowseDirectory } from "./default-browse-directory"

const api = vi.hoisted(() => ({
  getHomeDirectory: vi.fn(),
  listDirectoryEntries: vi.fn(),
}))
vi.mock("@/lib/api", () => api)

beforeEach(() => {
  api.getHomeDirectory.mockReset()
  api.listDirectoryEntries.mockReset()
  api.getHomeDirectory.mockResolvedValue("/root")
})

describe("resolveDefaultBrowseDirectory", () => {
  it("opens ~/codes when that directory exists", async () => {
    api.listDirectoryEntries.mockImplementation((path: string) =>
      path === "/root/codes"
        ? Promise.resolve([])
        : Promise.reject(new Error("missing"))
    )

    await expect(resolveDefaultBrowseDirectory()).resolves.toBe("/root/codes")
    expect(api.listDirectoryEntries).toHaveBeenCalledTimes(1)
  })

  it("falls through to ~/Codes when only that spelling exists", async () => {
    api.listDirectoryEntries.mockImplementation((path: string) =>
      path === "/root/Codes"
        ? Promise.resolve([])
        : Promise.reject(new Error("missing"))
    )

    await expect(resolveDefaultBrowseDirectory()).resolves.toBe("/root/Codes")
  })

  it("stays on the account home when neither projects directory exists", async () => {
    api.listDirectoryEntries.mockRejectedValue(new Error("missing"))

    await expect(resolveDefaultBrowseDirectory()).resolves.toBe("/root")
  })
})
