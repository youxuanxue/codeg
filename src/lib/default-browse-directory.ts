import { getHomeDirectory, listDirectoryEntries } from "@/lib/api"
import type { DirectoryEntry } from "@/lib/types"

/**
 * Folder names preferred under the account home, in that order. `codes` is
 * the projects root on this machine; `Codes` is the same tree when the
 * volume preserved the macOS spelling.
 */
const PROJECT_ROOT_NAMES = ["codes", "Codes"] as const

/**
 * Where a directory picker opens when the caller did not pass a path.
 *
 * The account home stays what the "home" button jumps to. Opening there is
 * useless when every project lives one level down, so prefer that directory
 * when it exists. The match is a child of the home listing, and the path
 * returned is that child's own path: on a case-insensitive volume a guessed
 * `home/codes` also lists successfully, but storing that spelling would
 * disagree with the directory entry and with folders already opened under
 * the preserved name.
 */
export async function resolveDefaultBrowseDirectory(): Promise<string> {
  const home = await getHomeDirectory()
  let entries: DirectoryEntry[]
  try {
    entries = await listDirectoryEntries(home)
  } catch {
    return home
  }
  for (const name of PROJECT_ROOT_NAMES) {
    const match = entries.find((entry) => entry.name === name)
    if (!match) continue
    try {
      // The home listing only proves the name is there. An unreadable
      // directory must fall through, same as a name that is absent.
      await listDirectoryEntries(match.path)
      return match.path
    } catch {
      // Try the next spelling.
    }
  }
  return home
}
