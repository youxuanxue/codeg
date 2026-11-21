import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest"

vi.mock("@/lib/api", () => ({
  acpSyncAntigravitySettings: vi.fn(),
  acpAntigravitySignOut: vi.fn(),
  acpScanLeakedTemp: vi.fn(),
  acpReclaimLeakedTemp: vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

import { toast } from "sonner"

import {
  acpAntigravitySignOut,
  acpReclaimLeakedTemp,
  acpScanLeakedTemp,
  acpSyncAntigravitySettings,
} from "@/lib/api"
import {
  ANTIGRAVITY_ENV_KEYS,
  AntigravityConfigPanel,
  antigravityIncompleteReason,
  buildAntigravityEnv,
  inferAntigravityMethod,
  type AntigravityAuthMethod,
  type AntigravityFormValues,
} from "./antigravity-config-panel"
import type { AcpAgentInfo } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"

function values(
  method: AntigravityAuthMethod,
  overrides: Partial<AntigravityFormValues> = {}
): AntigravityFormValues {
  return {
    method,
    geminiApiKey: "",
    baseUrl: "",
    googleApiKey: "",
    gcpProject: "",
    gcpLocation: "",
    ...overrides,
  }
}

describe("inferAntigravityMethod", () => {
  it("defaults to the browser login and rejects anything unrecognized", () => {
    // The default matters: it is the one path that needs no credential, so a
    // row with nothing recorded still produces a workable settings.json.
    expect(inferAntigravityMethod({})).toBe("oauth-personal")
    expect(inferAntigravityMethod({ AGY_AUTH_METHOD: "vertex-ai" })).toBe(
      "oauth-personal"
    )
    expect(inferAntigravityMethod({ AGY_AUTH_METHOD: "" })).toBe(
      "oauth-personal"
    )
    expect(inferAntigravityMethod({ AGY_AUTH_METHOD: "agent-platform" })).toBe(
      "agent-platform"
    )
  })
})

describe("buildAntigravityEnv", () => {
  it("keeps only the credential the chosen method uses and preserves the rest", () => {
    // Switching away from API-key auth must DELETE the key. Leaving it would
    // authenticate as something the user did not pick and would contradict the
    // native authentication selection.
    const stale = {
      KEEP: "y",
      GOOGLE_GEMINI_BASE_URL: "https://stale.example",
      GEMINI_API_KEY: "old",
      GOOGLE_API_KEY: "older",
      GOOGLE_CLOUD_PROJECT: "p",
      GOOGLE_CLOUD_LOCATION: "global",
    }
    expect(buildAntigravityEnv(stale, values("oauth-personal"))).toEqual({
      KEEP: "y",
      AGY_AUTH_METHOD: "oauth-personal",
    })

    expect(
      buildAntigravityEnv(
        stale,
        values("gemini-api-key", { geminiApiKey: "  AIza-new  " })
      )
    ).toEqual({
      KEEP: "y",
      AGY_AUTH_METHOD: "gemini-api-key",
      GEMINI_API_KEY: "AIza-new",
    })
  })

  it("gives Gemini Enterprise its project and location", () => {
    // oauth-business reads gcp.project/location from settings.json only, and
    // the launch path copies them out of these very env values.
    expect(
      buildAntigravityEnv(
        {},
        values("oauth-business", { gcpProject: "acme", gcpLocation: "eu" })
      )
    ).toEqual({
      AGY_AUTH_METHOD: "oauth-business",
      GOOGLE_CLOUD_PROJECT: "acme",
      GOOGLE_CLOUD_LOCATION: "eu",
    })
  })

  it("lets an Agent Platform API key suppress the project and location", () => {
    // The panel gives API-key and ADC configuration distinct ownership.
    expect(
      buildAntigravityEnv(
        {},
        values("agent-platform", {
          googleApiKey: "AIza-vertex",
          gcpProject: "ignored",
          gcpLocation: "ignored",
        })
      )
    ).toEqual({
      AGY_AUTH_METHOD: "agent-platform",
      GOOGLE_API_KEY: "AIza-vertex",
    })

    expect(
      buildAntigravityEnv(
        {},
        values("agent-platform", { gcpProject: "p", gcpLocation: "us" })
      )
    ).toEqual({
      AGY_AUTH_METHOD: "agent-platform",
      GOOGLE_CLOUD_PROJECT: "p",
      GOOGLE_CLOUD_LOCATION: "us",
    })
  })

  it("writes every key the settings page has to fold into the raw draft", () => {
    // ANTIGRAVITY_ENV_KEYS is what `persistEnv`'s draftEnvPatch iterates; a key
    // this panel writes but that list omits would be silently dropped the next
    // time the enable switch persists the draft wholesale.
    const written = buildAntigravityEnv(
      {},
      values("agent-platform", { gcpProject: "p", gcpLocation: "us" })
    )
    for (const key of Object.keys(written)) {
      expect(ANTIGRAVITY_ENV_KEYS).toContain(key)
    }
  })
})

describe("antigravityIncompleteReason", () => {
  it("mirrors the server's own auth_required rules", () => {
    // Browser login needs nothing — the server opens a browser at session/new.
    expect(antigravityIncompleteReason(values("oauth-personal"))).toBeNull()

    expect(antigravityIncompleteReason(values("gemini-api-key"))).toBe(
      "missingGeminiApiKey"
    )
    expect(
      antigravityIncompleteReason(
        values("gemini-api-key", { geminiApiKey: "AIza" })
      )
    ).toBeNull()

    // Agent Platform: a key OR both a project and a location.
    expect(antigravityIncompleteReason(values("agent-platform"))).toBe(
      "missingAgentPlatformConfig"
    )
    expect(
      antigravityIncompleteReason(values("agent-platform", { gcpProject: "p" }))
    ).toBe("missingAgentPlatformConfig")
    expect(
      antigravityIncompleteReason(
        values("agent-platform", { gcpProject: "p", gcpLocation: "us" })
      )
    ).toBeNull()
    expect(
      antigravityIncompleteReason(
        values("agent-platform", { googleApiKey: "AIza" })
      )
    ).toBeNull()

    // Gemini Enterprise needs BOTH; the server falls through to its no-config
    // path on a partial one.
    expect(
      antigravityIncompleteReason(
        values("oauth-business", { gcpProject: "acme" })
      )
    ).toBe("missingEnterpriseConfig")
    expect(
      antigravityIncompleteReason(
        values("oauth-business", { gcpProject: "acme", gcpLocation: "eu" })
      )
    ).toBeNull()
  })
})

describe("AntigravityConfigPanel", () => {
  const m = enMessages.AcpAgentSettings.antigravity

  type PanelOverrides = {
    env?: Record<string, string>
    onSaveEnv?: Mock
    onSaved?: Mock
  }

  function agentOf(overrides?: PanelOverrides): AcpAgentInfo {
    return {
      agent_type: "antigravity",
      enabled: true,
      env: overrides?.env ?? {},
      config_json: null,
      config_file_path: "/home/u/.gemini/antigravity-cli/settings.json",
    } as unknown as AcpAgentInfo
  }

  function renderPanel(overrides?: PanelOverrides) {
    const onSaveEnv = overrides?.onSaveEnv ?? vi.fn().mockResolvedValue(0)
    const onSaved = overrides?.onSaved ?? vi.fn()
    const tree = (agent: AcpAgentInfo) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AntigravityConfigPanel
          agent={agent}
          saving={false}
          onSaveEnv={onSaveEnv}
          onSaved={onSaved}
        />
      </NextIntlClientProvider>
    )
    const view = render(tree(agentOf(overrides)))
    return {
      onSaveEnv,
      onSaved,
      unmount: view.unmount,
      rerender: (next: PanelOverrides) =>
        view.rerender(tree(agentOf({ ...overrides, ...next }))),
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(acpSyncAntigravitySettings).mockResolvedValue({
      path: "/home/u/.gemini/antigravity-cli/settings.json",
      status: "written",
      reason: null,
    })
  })

  it("persists a TokenKey endpoint and key together and refreshes both from saved state", async () => {
    const panel = renderPanel({
      env: {
        AGY_AUTH_METHOD: "gemini-api-key",
        GEMINI_API_KEY: "old",
        GOOGLE_GEMINI_BASE_URL: "https://old.example",
      },
    })
    fireEvent.change(screen.getByLabelText(m.geminiApiKeyLabel), {
      target: { value: "  tokenkey-test-key  " },
    })
    fireEvent.change(screen.getByLabelText(m.baseUrlLabel), {
      target: { value: "  https://api.tokenkey.dev  " },
    })
    fireEvent.click(screen.getByRole("button", { name: m.save }))
    await waitFor(() =>
      expect(panel.onSaveEnv).toHaveBeenCalledWith(
        {
          AGY_AUTH_METHOD: "gemini-api-key",
          GEMINI_API_KEY: "tokenkey-test-key",
          GOOGLE_GEMINI_BASE_URL: "https://api.tokenkey.dev",
        },
        true
      )
    )
    await waitFor(() => expect(panel.onSaved).toHaveBeenCalled())
    panel.rerender({
      env: {
        AGY_AUTH_METHOD: "gemini-api-key",
        GEMINI_API_KEY: "newer",
        GOOGLE_GEMINI_BASE_URL: "https://new.example",
      },
    })
    expect(screen.getByLabelText(m.baseUrlLabel)).toHaveValue(
      "https://new.example"
    )
  })

  it("preserves a new endpoint edit while a previous save is pending", async () => {
    let finishSave!: (value: number) => void
    const panel = renderPanel({
      env: { AGY_AUTH_METHOD: "gemini-api-key", GEMINI_API_KEY: "key" },
      onSaveEnv: vi.fn(
        () =>
          new Promise<number>((resolve) => {
            finishSave = resolve
          })
      ),
    })
    const endpoint = screen.getByLabelText(m.baseUrlLabel)
    fireEvent.change(endpoint, {
      target: { value: "https://submitted.example" },
    })
    fireEvent.click(screen.getByRole("button", { name: m.save }))
    fireEvent.change(endpoint, {
      target: { value: "https://still-typing.example" },
    })
    finishSave(0)
    await waitFor(() => expect(panel.onSaved).toHaveBeenCalled())
    panel.rerender({
      env: {
        AGY_AUTH_METHOD: "gemini-api-key",
        GEMINI_API_KEY: "key",
        GOOGLE_GEMINI_BASE_URL: "https://submitted.example",
      },
    })
    expect(endpoint).toHaveValue("https://still-typing.example")
  })

  it("does not claim success when the settings file was left alone", async () => {
    vi.mocked(acpSyncAntigravitySettings).mockResolvedValue({
      path: "/home/u/.gemini/antigravity-cli/settings.json",
      status: "skipped",
      reason: "it is not strict JSON codeg can rewrite without losing content",
    })
    const onSaved = vi.fn()
    renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" }, onSaved })

    fireEvent.click(screen.getByRole("button", { name: m.save }))

    await waitFor(() => expect(toast.warning).toHaveBeenCalled())
    expect(toast.success).not.toHaveBeenCalled()
    // And it stays on screen: this is a standing disagreement between the form
    // and the file, not a four-second event.
    expect(await screen.findByText(m.syncSkipped)).toBeInTheDocument()
    expect(
      screen.getByText(
        "it is not strict JSON codeg can rewrite without losing content"
      )
    ).toBeInTheDocument()
    // The row itself DID save, so the panel still reports the save as done.
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it("reports a plain success when the file was written", async () => {
    renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
    fireEvent.click(screen.getByRole("button", { name: m.save }))

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(toast.warning).not.toHaveBeenCalled()
    expect(screen.queryByText(m.syncSkipped)).not.toBeInTheDocument()
  })

  /** A transport failure on the REPORT must not turn a stored row into a
   *  failed save — the launch-time sync still runs either way. */
  it("still reports the save when the sync probe itself fails", async () => {
    vi.mocked(acpSyncAntigravitySettings).mockRejectedValue(
      new Error("offline")
    )
    const onSaved = vi.fn()
    renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" }, onSaved })

    fireEvent.click(screen.getByRole("button", { name: m.save }))

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(toast.success).toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("shows the browser-login hint and the settings.json path by default", () => {
    renderPanel()
    // OAuth directs users to native agy login on the same host.
    expect(
      screen.getByText(m.methodHints["oauth-personal"])
    ).toBeInTheDocument()
    expect(
      screen.getByText("/home/u/.gemini/antigravity-cli/settings.json")
    ).toBeInTheDocument()
    // Nothing to fill in, so no warning.
    expect(screen.queryByText(m.missingGeminiApiKey)).not.toBeInTheDocument()
  })

  it("warns when the persisted method has no usable credential", () => {
    renderPanel({ env: { AGY_AUTH_METHOD: "gemini-api-key" } })
    expect(screen.getByText(m.missingGeminiApiKey)).toBeInTheDocument()
  })

  it("saves the credential the persisted method uses and drops the others", async () => {
    const onSaveEnv = vi.fn().mockResolvedValue(0)
    const onSaved = vi.fn()
    renderPanel({
      env: {
        AGY_AUTH_METHOD: "gemini-api-key",
        GEMINI_API_KEY: "old",
        GOOGLE_API_KEY: "stale",
        KEEP: "y",
      },
      onSaveEnv,
      onSaved,
    })

    fireEvent.change(screen.getByLabelText(m.geminiApiKeyLabel), {
      target: { value: "AIza-new" },
    })
    fireEvent.click(screen.getByRole("button", { name: m.save }))

    await waitFor(() => expect(onSaveEnv).toHaveBeenCalledTimes(1))
    expect(onSaveEnv).toHaveBeenCalledWith(
      {
        KEEP: "y",
        AGY_AUTH_METHOD: "gemini-api-key",
        GEMINI_API_KEY: "AIza-new",
      },
      true
    )
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it("keeps an in-progress edit when the persisted row changes underneath", () => {
    const { rerender } = renderPanel({
      env: { AGY_AUTH_METHOD: "gemini-api-key", GEMINI_API_KEY: "old" },
    })
    const input = screen.getByLabelText(m.geminiApiKeyLabel)
    fireEvent.change(input, { target: { value: "typing-in-progress" } })

    // The settings page refetches after any save (possibly one from another
    // panel); a re-seed here would throw away what the user is typing.
    rerender({
      env: { AGY_AUTH_METHOD: "gemini-api-key", GEMINI_API_KEY: "x" },
    })
    expect((input as HTMLInputElement).value).toBe("typing-in-progress")
  })

  it("re-seeds from the persisted row while the form is untouched", () => {
    const { rerender } = renderPanel({
      env: { AGY_AUTH_METHOD: "oauth-business", GOOGLE_CLOUD_PROJECT: "acme" },
    })
    expect(
      (screen.getByLabelText(m.gcpProjectLabel) as HTMLInputElement).value
    ).toBe("acme")

    rerender({
      env: {
        AGY_AUTH_METHOD: "oauth-business",
        GOOGLE_CLOUD_PROJECT: "acme-2",
      },
    })
    expect(
      (screen.getByLabelText(m.gcpProjectLabel) as HTMLInputElement).value
    ).toBe("acme-2")
  })

  describe("sign-out", () => {
    const s = m.signOut

    beforeEach(() => {
      vi.mocked(acpAntigravitySignOut).mockResolvedValue({
        path: "/home/u/.gemini/antigravity-cli/settings.json",
        status: "written",
        reason: null,
      })
    })

    it("offers itself only for the methods with a credential to discard", () => {
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      expect(screen.getByRole("button", { name: s.action })).toBeInTheDocument()

      // An API-key method reads its credential from the environment on every
      // request, so there is nothing stored to sign out of.
      fireEvent.click(screen.getByLabelText(m.methodLabel))
      fireEvent.click(
        screen.getByRole("option", { name: m.methods["gemini-api-key"] })
      )
      expect(screen.queryByRole("button", { name: s.action })).toBeNull()
    })

    it("clears the credential and says another account can be picked", async () => {
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: s.action }))

      await waitFor(() => expect(acpAntigravitySignOut).toHaveBeenCalled())
      expect(toast.success).toHaveBeenCalledWith(s.done)
    })

    /**
     * The agent's `logout` removes `auth.type` on its way out and the backend
     * writes the saved method straight back. When that write is refused the
     * file now names NO method, and every later session fails outright with
     * "Authentication required" — so this is the one outcome the panel must not
     * report as a plain success.
     */
    it("warns when the settings file could not be rewritten afterwards", async () => {
      vi.mocked(acpAntigravitySignOut).mockResolvedValue({
        path: "/home/u/.gemini/antigravity-cli/settings.json",
        status: "skipped",
        reason:
          "it is not strict JSON codeg can rewrite without losing content",
      })
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: s.action }))

      await waitFor(() => expect(toast.warning).toHaveBeenCalled())
      expect(toast.success).not.toHaveBeenCalled()
      // And it stays on screen, because it stays true until someone edits that
      // file — the same standing notice a refused save raises.
      expect(await screen.findByText(m.syncSkipped)).toBeInTheDocument()
      expect(
        screen.getByText(
          "it is not strict JSON codeg can rewrite without losing content"
        )
      ).toBeInTheDocument()
    })

    /**
     * A stored row missing its project or location gates the SIGN-IN, because
     * consenting without one only fails at license resolution. Signing out
     * needs none of it — and a half-configured row is exactly what a user
     * trying to leave the wrong account is likely to have.
     */
    it("stays available when the stored row cannot sign in", () => {
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-business" } })
      expect(screen.getByText("agy acp --login")).toBeInTheDocument()
      expect(screen.getByRole("button", { name: s.action })).toBeEnabled()
    })

    it("shows the backend's message when the transport throws its JSON", async () => {
      vi.mocked(acpAntigravitySignOut).mockRejectedValue({
        code: "AcpError",
        message: "Google Antigravity is not installed.",
      })
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: s.action }))

      await waitFor(() => expect(toast.error).toHaveBeenCalled())
      expect(String(vi.mocked(toast.error).mock.calls[0]?.[0])).toContain(
        "Google Antigravity is not installed."
      )
      // The toast goes up before the render that releases the button.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: s.action })).toBeEnabled()
      )
    })
  })
  /**
   * The temp reclaim is a delete against the SYSTEM temp directory, which every
   * PyInstaller application on the machine shares. The panel's own copy admits
   * codeg cannot tell its own leftovers from someone else's — so consent has to
   * be per path, and it cannot be the default.
   */
  describe("leaked temp reclaim", () => {
    const r = enMessages.AcpAgentSettings.antigravity

    const scan = {
      root: "/tmp",
      total_bytes: 3_000_000,
      skipped: 1,
      entries: [
        {
          path: "/tmp/_MEI111111",
          bytes: 2_000_000,
          age_hours: 30,
          is_dir: true,
        },
        {
          path: "/tmp/_MEI222222",
          bytes: 1_000_000,
          age_hours: 5,
          is_dir: true,
        },
      ],
    }

    it("lists every path and pre-selects none of them", async () => {
      vi.mocked(acpScanLeakedTemp).mockResolvedValue(scan)
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })

      fireEvent.click(screen.getByRole("button", { name: r.tempReclaimScan }))

      await screen.findByText("/tmp/_MEI111111")
      expect(screen.getByText("/tmp/_MEI222222")).toBeInTheDocument()
      for (const box of screen.getAllByRole("checkbox")) {
        expect(box).toHaveAttribute("data-state", "unchecked")
      }
      // Nothing selected means nothing to delete, so the destructive action is
      // not reachable at all.
      expect(
        screen.getByRole("button", { name: r.tempReclaimDelete })
      ).toBeDisabled()
    })

    it("deletes only what was ticked, and only after a confirmation", async () => {
      vi.mocked(acpScanLeakedTemp).mockResolvedValue(scan)
      vi.mocked(acpReclaimLeakedTemp).mockResolvedValue({
        removed: 1,
        freed_bytes: 2_000_000,
        failed: [],
      })
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: r.tempReclaimScan }))
      await screen.findByText("/tmp/_MEI111111")

      // Tick the first entry only. Index 0 is the select-all header box.
      fireEvent.click(screen.getAllByRole("checkbox")[1])
      fireEvent.click(screen.getByRole("button", { name: r.tempReclaimDelete }))

      // The click opens the dialog; it must not have deleted anything yet.
      expect(acpReclaimLeakedTemp).not.toHaveBeenCalled()
      fireEvent.click(
        await screen.findByRole("button", { name: r.tempReclaimConfirmAction })
      )

      await waitFor(() => expect(acpReclaimLeakedTemp).toHaveBeenCalled())
      expect(acpReclaimLeakedTemp).toHaveBeenCalledWith(["/tmp/_MEI111111"])
    })

    it("shows every path the backend refused, not just the first", async () => {
      vi.mocked(acpScanLeakedTemp).mockResolvedValue(scan)
      vi.mocked(acpReclaimLeakedTemp).mockResolvedValue({
        removed: 0,
        freed_bytes: 0,
        failed: ["/tmp/_MEI111111: in use", "/tmp/_MEI222222: access denied"],
      })
      renderPanel({ env: { AGY_AUTH_METHOD: "oauth-personal" } })
      fireEvent.click(screen.getByRole("button", { name: r.tempReclaimScan }))
      await screen.findByText("/tmp/_MEI111111")

      fireEvent.click(screen.getAllByRole("checkbox")[0])
      fireEvent.click(screen.getByRole("button", { name: r.tempReclaimDelete }))
      fireEvent.click(
        await screen.findByRole("button", { name: r.tempReclaimConfirmAction })
      )

      await screen.findByText("/tmp/_MEI111111: in use")
      expect(
        screen.getByText("/tmp/_MEI222222: access denied")
      ).toBeInTheDocument()
    })
  })
})
