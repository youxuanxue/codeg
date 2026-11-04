import { beforeEach, describe, expect, it, vi } from "vitest"

import type { DirectoryEntry } from "@/lib/types"

import { resolveDefaultBrowseDirectory } from "./default-browse-directory"

const api = vi.hoisted(() => ({
  getHomeDirectory: vi.fn(),
  listDirectoryEntries: vi.fn(),
}))
vi.mock("@/lib/api", () => api)

const dir = (
  name: string,
  path: string,
  hasChildren = false
): DirectoryEntry => ({ name, path, hasChildren })

beforeEach(() => {
  api.getHomeDirectory.mockReset()
  api.listDirectoryEntries.mockReset()
  api.getHomeDirectory.mockResolvedValue("/root")
})

describe("resolveDefaultBrowseDirectory", () => {
  it("opens the codes entry from the home listing", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      dir("codes", "/root/codes", true),
    ])

    await expect(resolveDefaultBrowseDirectory()).resolves.toBe("/root/codes")
    expect(api.listDirectoryEntries).toHaveBeenNthCalledWith(1, "/root")
    expect(api.listDirectoryEntries).toHaveBeenNthCalledWith(2, "/root/codes")
  })

  it("prefers codes over Codes when both entries exist", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      dir("Codes", "/root/Codes"),
      dir("codes", "/root/codes"),
    ])

    await expect(resolveDefaultBrowseDirectory()).resolves.toBe("/root/codes")
  })

  it("uses the Codes entry path when that is the on-disk spelling", async () => {
    api.listDirectoryEntries.mockImplementation((path: string) => {
      if (path === "/root") {
        return Promise.resolve([dir("Codes", "/root/Codes", true)])
      }
      if (path === "/root/Codes") return Promise.resolve([])
      // A case-insensitive volume would also list this guessed path.
      if (path === "/root/codes") return Promise.resolve([])
      return Promise.reject(new Error("missing"))
    })

    await expect(resolveDefaultBrowseDirectory()).resolves.toBe("/root/Codes")
    expect(api.listDirectoryEntries).toHaveBeenNthCalledWith(1, "/root")
    expect(api.listDirectoryEntries).toHaveBeenNthCalledWith(2, "/root/Codes")
    expect(api.listDirectoryEntries).not.toHaveBeenCalledWith("/root/codes")
  })

  it("stays on the account home when neither projects directory exists", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      dir("Documents", "/root/Documents"),
    ])

    await expect(resolveDefaultBrowseDirectory()).resolves.toBe("/root")
    expect(api.listDirectoryEntries).toHaveBeenCalledTimes(1)
  })

  it("skips a projects directory that is present but unreadable", async () => {
    api.listDirectoryEntries.mockImplementation((path: string) => {
      if (path === "/root") {
        return Promise.resolve([dir("codes", "/root/codes", true)])
      }
      return Promise.reject(new Error("denied"))
    })

    await expect(resolveDefaultBrowseDirectory()).resolves.toBe("/root")
    expect(api.listDirectoryEntries).not.toHaveBeenCalledWith("/root/Codes")
  })

  it("stays on the account home when the home listing fails", async () => {
    api.listDirectoryEntries.mockRejectedValue(new Error("missing"))

    await expect(resolveDefaultBrowseDirectory()).resolves.toBe("/root")
  })

  it("propagates a home lookup failure", async () => {
    api.getHomeDirectory.mockRejectedValue(new Error("no home"))

    await expect(resolveDefaultBrowseDirectory()).rejects.toThrow("no home")
    expect(api.listDirectoryEntries).not.toHaveBeenCalled()
  })
})
