import { getHomeDirectory, listDirectoryEntries } from "@/lib/api"
import { joinFsPath } from "@/lib/path-utils"

/**
 * Folder names tried under the account home, in that order. `codes` is the
 * projects root on this machine; `Codes` is the same tree on a case-sensitive
 * volume that kept the macOS spelling.
 */
const PROJECT_ROOT_NAMES = ["codes", "Codes"] as const

/**
 * Where a directory picker opens when the caller did not pass a path.
 *
 * The account home stays what the "home" button jumps to. Opening there is
 * useless when every project lives one level down, so prefer that directory
 * when it exists.
 */
export async function resolveDefaultBrowseDirectory(): Promise<string> {
  const home = await getHomeDirectory()
  for (const name of PROJECT_ROOT_NAMES) {
    const candidate = joinFsPath(home, name)
    try {
      await listDirectoryEntries(candidate)
      return candidate
    } catch {
      // Not a directory, or not readable. Try the next spelling.
    }
  }
  return home
}
