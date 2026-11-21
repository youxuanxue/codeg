"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Copy, Eye, EyeOff, HardDrive, Loader2, Save } from "lucide-react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  acpAntigravitySignOut,
  acpReclaimLeakedTemp,
  acpScanLeakedTemp,
  acpSyncAntigravitySettings,
  type AntigravitySyncReport,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { copyTextToClipboard } from "@/lib/utils"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { AcpAgentInfo, LeakedTempScan } from "@/lib/types"

/** Codeg records the method for native ACP authenticate and launch credential isolation. */
const AGY_AUTH_METHOD_ENV = "AGY_AUTH_METHOD"
/** The Gemini Developer API key, read when native `modelProvider` is `gemini`. */
const GEMINI_API_KEY_ENV = "GEMINI_API_KEY"
const GEMINI_BASE_URL_ENV = "GOOGLE_GEMINI_BASE_URL"
/** Agent Platform API key; alternatively use project/location with ADC. */
const GOOGLE_API_KEY_ENV = "GOOGLE_API_KEY"
const GOOGLE_CLOUD_PROJECT_ENV = "GOOGLE_CLOUD_PROJECT"
const GOOGLE_CLOUD_LOCATION_ENV = "GOOGLE_CLOUD_LOCATION"

/** Every key this panel owns, so the settings page can fold the whole set into
 * the raw env draft (see `persistEnv`'s `draftEnvPatch`). */
export const ANTIGRAVITY_ENV_KEYS = [
  AGY_AUTH_METHOD_ENV,
  GEMINI_API_KEY_ENV,
  GEMINI_BASE_URL_ENV,
  GOOGLE_API_KEY_ENV,
  GOOGLE_CLOUD_PROJECT_ENV,
  GOOGLE_CLOUD_LOCATION_ENV,
] as const

/** Authentication method IDs advertised by native agy at initialize. */
export type AntigravityAuthMethod =
  | "oauth-personal"
  | "oauth-business"
  | "gemini-api-key"
  | "agent-platform"

const AUTH_METHODS: AntigravityAuthMethod[] = [
  "oauth-personal",
  "oauth-business",
  "gemini-api-key",
  "agent-platform",
]

function isAuthMethod(value: string): value is AntigravityAuthMethod {
  return (AUTH_METHODS as string[]).includes(value)
}

/** The persisted method, defaulting to the browser login — the one path that
 * needs no credential of its own, and the one most users are on. */
export function inferAntigravityMethod(
  env: Record<string, string>
): AntigravityAuthMethod {
  const explicit = (env[AGY_AUTH_METHOD_ENV] ?? "").trim()
  return isAuthMethod(explicit) ? explicit : "oauth-personal"
}

export interface AntigravityFormValues {
  method: AntigravityAuthMethod
  geminiApiKey: string
  baseUrl: string
  googleApiKey: string
  gcpProject: string
  gcpLocation: string
}

/**
 * Build the env map to persist.
 *
 * Only the credentials the chosen method actually consumes are written; every
 * other one is DELETED rather than left behind. That matters because the
 * method and the credential are not independent here — a `GEMINI_API_KEY` left
 * over from a previous choice would authenticate the user as something they
 * did not pick, and would contradict the `modelProvider` the same launch writes to
 * `settings.json`. (The launch path scrubs them again for the same reason; this
 * is the half that keeps the stored row honest.)
 *
 * `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` are kept for BOTH
 * `agent-platform` (which reads them from the environment) and `oauth-business`
 * (which reads project/location from `settings.json` only — the launch path
 * copies them into the `gcp` block from these same values).
 *
 * Unrelated keys are preserved untouched.
 */
export function buildAntigravityEnv(
  prevEnv: Record<string, string>,
  values: AntigravityFormValues
): Record<string, string> {
  const env: Record<string, string> = { ...prevEnv }
  const set = (key: string, value: string) => {
    const trimmed = value.trim()
    if (trimmed) {
      env[key] = trimmed
    } else {
      delete env[key]
    }
  }

  env[AGY_AUTH_METHOD_ENV] = values.method
  for (const key of [
    GEMINI_API_KEY_ENV,
    GEMINI_BASE_URL_ENV,
    GOOGLE_API_KEY_ENV,
    GOOGLE_CLOUD_PROJECT_ENV,
    GOOGLE_CLOUD_LOCATION_ENV,
  ]) {
    delete env[key]
  }

  if (values.method === "gemini-api-key") {
    set(GEMINI_API_KEY_ENV, values.geminiApiKey)
    set(GEMINI_BASE_URL_ENV, values.baseUrl)
  }
  if (values.method === "agent-platform") {
    set(GOOGLE_API_KEY_ENV, values.googleApiKey)
    // The API key suppresses project/location server-side, so writing all
    // three would silently ignore two of them. Keep the row matching what the
    // server will actually use.
    if (!values.googleApiKey.trim()) {
      set(GOOGLE_CLOUD_PROJECT_ENV, values.gcpProject)
      set(GOOGLE_CLOUD_LOCATION_ENV, values.gcpLocation)
    }
  }
  if (values.method === "oauth-business") {
    set(GOOGLE_CLOUD_PROJECT_ENV, values.gcpProject)
    set(GOOGLE_CLOUD_LOCATION_ENV, values.gcpLocation)
  }

  return env
}

/** Missing configuration for the selected method; OAuth uses native agy login. */
export function antigravityIncompleteReason(
  values: AntigravityFormValues
):
  | "missingGeminiApiKey"
  | "missingAgentPlatformConfig"
  | "missingEnterpriseConfig"
  | null {
  const has = (value: string) => value.trim().length > 0
  switch (values.method) {
    case "gemini-api-key":
      return has(values.geminiApiKey) ? null : "missingGeminiApiKey"
    case "agent-platform":
      if (has(values.googleApiKey)) return null
      return has(values.gcpProject) && has(values.gcpLocation)
        ? null
        : "missingAgentPlatformConfig"
    case "oauth-business":
      return has(values.gcpProject) && has(values.gcpLocation)
        ? null
        : "missingEnterpriseConfig"
    default:
      return null
  }
}

/** The two methods that authenticate through Antigravity's own browser flow —
 *  and therefore the only two a machine with no browser cannot complete on its
 *  own. The API-key methods read their credential from the environment. */
function usesBrowserSignIn(method: AntigravityAuthMethod): boolean {
  return method === "oauth-personal" || method === "oauth-business"
}

/** Native OAuth belongs to agy, which shares its secure account store. */
function NativeSignIn() {
  const t = useTranslations("AcpAgentSettings")
  const command = "agy acp --login"
  return (
    <div className="space-y-1 rounded-md border p-2">
      <p className="text-2xs text-muted-foreground">
        {t("antigravity.nativeLoginHint")}
      </p>
      <div className="flex items-center gap-2">
        <code className="text-2xs">{command}</code>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          onClick={() => void copyTextToClipboard(command)}
        >
          <Copy className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )
}

/** Sign out of the shared native account after stopping Codeg connections. */
function SignOut({
  disabled,
  onSignedOut,
}: {
  disabled: boolean
  /** Hands back the settings.json report the sign-out produced, so the panel
   *  can raise its standing notice when that file could not be rewritten. */
  onSignedOut: (report: AntigravitySyncReport) => void
}) {
  const t = useTranslations("AcpAgentSettings")
  const [busy, setBusy] = useState(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const signOut = useCallback(async () => {
    setBusy(true)
    try {
      const report = await acpAntigravitySignOut()
      if (!mountedRef.current) return
      onSignedOut(report)
      if (report.status === "skipped") {
        toast.warning(t("toasts.antigravitySyncSkipped"))
      } else {
        toast.success(t("antigravity.signOut.done"))
      }
    } catch (e) {
      // NOT `String(e)`: the web transport throws the backend's `{code,
      // message}` JSON verbatim, and this is the deployment where the
      // actionable text ("Google Antigravity is not installed") matters most.
      toast.error(`${t("antigravity.signOut.failed")}: ${toErrorMessage(e)}`)
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }, [onSignedOut, t])

  return (
    <div className="flex items-start justify-between gap-2 rounded-md border border-dashed p-2.5">
      <div className="min-w-0">
        <p className="text-2xs font-medium">{t("antigravity.signOut.title")}</p>
        <p className="mt-0.5 text-3xs text-muted-foreground">
          {t("antigravity.signOut.description")}
        </p>
      </div>
      <Button
        className="h-7 shrink-0 gap-1.5 px-2.5 text-xs"
        disabled={disabled || busy}
        onClick={() => void signOut()}
        size="sm"
        type="button"
        variant="outline"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {t("antigravity.signOut.action")}
      </Button>
    </div>
  )
}

/** Human-readable byte count. Binary units — these are disk sizes. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

/**
 * One-time reclamation of temp directories leaked by launches from BEFORE
 * per-launch isolation shipped.
 *
 * Scan-then-confirm rather than a silent sweep, and the copy says why: the
 * directories live in the system temp dir, which every PyInstaller application
 * shares. codeg cannot tell its own leftovers from another app's, so deleting
 * them is the user's call, not codeg's.
 */
function LeakedTempSection() {
  const t = useTranslations("AcpAgentSettings")
  const [scan, setScan] = useState<LeakedTempScan | null>(null)
  /** Paths the user has explicitly opted in. Starts empty — see the render. */
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [failed, setFailed] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const runScan = useCallback(async () => {
    setBusy(true)
    try {
      setScan(await acpScanLeakedTemp())
      // A new scan is a new set of paths; carrying ticks across would let a
      // path the user never looked at arrive pre-approved.
      setSelected(new Set())
      setFailed([])
    } catch (err) {
      toast.error(toErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }, [])

  const chosen = useMemo(
    () => scan?.entries.filter((entry) => selected.has(entry.path)) ?? [],
    [scan, selected]
  )
  const chosenBytes = chosen.reduce((total, entry) => total + entry.bytes, 0)

  const runReclaim = useCallback(async () => {
    setConfirming(false)
    if (chosen.length === 0) return
    setBusy(true)
    try {
      const result = await acpReclaimLeakedTemp(chosen.map((e) => e.path))
      toast.success(
        t("antigravity.tempReclaimed", {
          count: result.removed,
          size: formatBytes(result.freed_bytes),
        })
      )
      // Every failure, not just the first: "removed 3 of 5" with three
      // unexplained survivors is the report that wastes the next hour.
      setFailed(result.failed)
      setScan(await acpScanLeakedTemp())
      setSelected(new Set())
    } catch (err) {
      toast.error(toErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }, [chosen, t])

  const toggle = useCallback((path: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  const allChecked: boolean | "indeterminate" =
    scan && scan.entries.length > 0 && selected.size === scan.entries.length
      ? true
      : selected.size > 0
        ? "indeterminate"
        : false

  return (
    <div className="space-y-1.5 rounded-md border bg-background/60 p-2.5">
      <div className="flex items-center gap-1.5">
        <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">
          {t("antigravity.tempReclaimTitle")}
        </span>
      </div>
      <p className="text-3xs text-muted-foreground">
        {t("antigravity.tempReclaimHint")}
      </p>

      {scan ? (
        <div className="space-y-1">
          <p className="text-2xs">
            {scan.entries.length === 0
              ? t("antigravity.tempReclaimNone")
              : t("antigravity.tempReclaimFound", {
                  count: scan.entries.length,
                  size: formatBytes(scan.total_bytes),
                })}
          </p>
          {scan.skipped > 0 ? (
            <p className="text-3xs text-muted-foreground">
              {t("antigravity.tempReclaimSkipped", { count: scan.skipped })}
            </p>
          ) : null}
          <code className="block overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-3xs whitespace-nowrap text-muted-foreground">
            {scan.root}
          </code>

          {/* Nothing is pre-ticked, and every path is shown. The hint above
              says codeg cannot tell its own leftovers from another
              application's; a single button that deleted all of them would be
              asking the user to take responsibility for a list they were never
              shown. */}
          {scan.entries.length > 0 ? (
            <div className="rounded border">
              <label className="flex items-center gap-2 border-b px-2 py-1">
                <Checkbox
                  checked={allChecked}
                  disabled={busy}
                  onCheckedChange={(value) =>
                    setSelected(
                      value === true
                        ? new Set(scan.entries.map((e) => e.path))
                        : new Set()
                    )
                  }
                />
                <span className="text-3xs text-muted-foreground">
                  {t("antigravity.tempReclaimSelectAll")}
                </span>
              </label>
              <div className="max-h-40 overflow-y-auto">
                {scan.entries.map((entry) => (
                  <label
                    className="flex items-center gap-2 px-2 py-1 hover:bg-muted/50"
                    key={entry.path}
                  >
                    <Checkbox
                      checked={selected.has(entry.path)}
                      disabled={busy}
                      onCheckedChange={(value) =>
                        toggle(entry.path, value === true)
                      }
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-3xs">
                      {entry.path}
                    </span>
                    <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">
                      {formatBytes(entry.bytes)}
                    </span>
                    <span className="shrink-0 text-3xs tabular-nums text-muted-foreground">
                      {t("antigravity.tempReclaimAgeHours", {
                        hours: entry.age_hours,
                      })}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}

          {failed.length > 0 ? (
            <ul className="space-y-0.5">
              {failed.map((message) => (
                <li className="text-3xs text-destructive" key={message}>
                  {message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="flex justify-end gap-1.5">
        <Button
          className="h-7 gap-1.5 px-2.5 text-xs"
          disabled={busy}
          onClick={() => void runScan()}
          size="sm"
          type="button"
          variant="outline"
        >
          {busy && !scan ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : null}
          {t("antigravity.tempReclaimScan")}
        </Button>
        {scan && scan.entries.length > 0 ? (
          <AlertDialog onOpenChange={setConfirming} open={confirming}>
            <AlertDialogTrigger asChild>
              <Button
                className="h-7 gap-1.5 px-2.5 text-xs"
                disabled={busy || chosen.length === 0}
                size="sm"
                type="button"
                variant="destructive"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {t("antigravity.tempReclaimDelete")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("antigravity.tempReclaimConfirmTitle", {
                    count: chosen.length,
                  })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("antigravity.tempReclaimConfirmBody", {
                    size: formatBytes(chosenBytes),
                  })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  {t("antigravity.tempReclaimCancel")}
                </AlertDialogCancel>
                <AlertDialogAction onClick={() => void runReclaim()}>
                  {t("antigravity.tempReclaimConfirmAction")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>
    </div>
  )
}

export function AntigravityConfigPanel({
  agent,
  saving,
  onSaveEnv,
  onSaved,
}: {
  agent: AcpAgentInfo
  saving: boolean
  onSaveEnv: (env: Record<string, string>, enabled: boolean) => Promise<unknown>
  onSaved: () => void
}) {
  const t = useTranslations("AcpAgentSettings")

  const [method, setMethod] = useState<AntigravityAuthMethod>(() =>
    inferAntigravityMethod(agent.env)
  )
  const [geminiApiKey, setGeminiApiKey] = useState(
    () => agent.env[GEMINI_API_KEY_ENV] ?? ""
  )
  const [baseUrl, setBaseUrl] = useState(
    () => agent.env[GEMINI_BASE_URL_ENV] ?? ""
  )
  const [googleApiKey, setGoogleApiKey] = useState(
    () => agent.env[GOOGLE_API_KEY_ENV] ?? ""
  )
  const [gcpProject, setGcpProject] = useState(
    () => agent.env[GOOGLE_CLOUD_PROJECT_ENV] ?? ""
  )
  const [gcpLocation, setGcpLocation] = useState(
    () => agent.env[GOOGLE_CLOUD_LOCATION_ENV] ?? ""
  )
  const [showKey, setShowKey] = useState(false)
  const [savingForm, setSavingForm] = useState(false)
  /** The last save whose settings.json write was REFUSED, or null. Held rather
   *  than left to the toast: this is a standing disagreement between the form
   *  and the file the agent reads, and it stays true until someone edits that
   *  file — a notice that scrolls away after four seconds would not say so. */
  const [syncSkip, setSyncSkip] = useState<AntigravitySyncReport | null>(null)

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Re-seed when the persisted row changes UNDER the panel (the settings page
  // refetches after every save, and another window can rewrite it). Edits in
  // progress win: `dirty` is a ref set by the change handlers rather than a
  // comparison against current state, because that state must NOT be a
  // dependency — between a save completing and the refresh it triggers, the
  // form already holds what was stored while `agent` still holds the pre-save
  // values, and a re-run would revert the save on screen.
  const persisted = useMemo(
    () => ({
      method: inferAntigravityMethod(agent.env),
      geminiApiKey: agent.env[GEMINI_API_KEY_ENV] ?? "",
      baseUrl: agent.env[GEMINI_BASE_URL_ENV] ?? "",
      googleApiKey: agent.env[GOOGLE_API_KEY_ENV] ?? "",
      gcpProject: agent.env[GOOGLE_CLOUD_PROJECT_ENV] ?? "",
      gcpLocation: agent.env[GOOGLE_CLOUD_LOCATION_ENV] ?? "",
    }),
    [agent.env]
  )
  const seeded = useRef(persisted)
  const dirty = useRef(false)
  useEffect(() => {
    const previous = seeded.current
    const changed =
      previous.method !== persisted.method ||
      previous.geminiApiKey !== persisted.geminiApiKey ||
      previous.baseUrl !== persisted.baseUrl ||
      previous.googleApiKey !== persisted.googleApiKey ||
      previous.gcpProject !== persisted.gcpProject ||
      previous.gcpLocation !== persisted.gcpLocation
    if (!changed) return
    seeded.current = persisted
    if (dirty.current) return
    setMethod(persisted.method)
    setGeminiApiKey(persisted.geminiApiKey)
    setBaseUrl(persisted.baseUrl)
    setGoogleApiKey(persisted.googleApiKey)
    setGcpProject(persisted.gcpProject)
    setGcpLocation(persisted.gcpLocation)
  }, [persisted])

  const values: AntigravityFormValues = {
    method,
    geminiApiKey,
    baseUrl,
    googleApiKey,
    gcpProject,
    gcpLocation,
  }
  const valuesRef = useRef(values)
  useEffect(() => {
    valuesRef.current = values
  })

  const incomplete = antigravityIncompleteReason(values)
  const save = useCallback(async () => {
    setSavingForm(true)
    const submitted = valuesRef.current
    try {
      await onSaveEnv(buildAntigravityEnv(agent.env, submitted), agent.enabled)
      // Only the exact values that just landed stop counting as an unsaved
      // edit: the form stays editable while the request is in flight, so
      // anything changed since is NEWER than what was stored.
      if (
        Object.entries(submitted).every(
          ([key, value]) =>
            valuesRef.current[key as keyof AntigravityFormValues] === value
        )
      )
        dirty.current = false

      // Native provider settings must agree with the saved authentication choice.
      let report: AntigravitySyncReport | null = null
      try {
        report = await acpSyncAntigravitySettings()
      } catch {
        // The sync is a report, not the save. A transport failure leaves the
        // row stored and the launch-time sync still to come, so it must not
        // turn a successful save into a failed one.
      }
      if (mountedRef.current)
        setSyncSkip(report?.status === "skipped" ? report : null)
      if (report?.status === "skipped") {
        toast.warning(t("toasts.antigravitySyncSkipped"))
      } else {
        toast.success(t("toasts.antigravitySaved"))
      }
      onSaved()
    } catch (e) {
      toast.error(
        `${t("toasts.saveAntigravityConfigFailed")}: ${toErrorMessage(e)}`
      )
    } finally {
      if (mountedRef.current) setSavingForm(false)
    }
  }, [agent.enabled, agent.env, onSaveEnv, onSaved, t])

  // Show any failure to restore provider settings after native logout.
  const onSignedOut = useCallback((report: AntigravitySyncReport) => {
    setSyncSkip(report.status === "skipped" ? report : null)
  }, [])

  const busy = saving || savingForm
  const markDirty = () => {
    dirty.current = true
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/10 p-3">
      <div>
        <label className="text-xs font-medium">{t("configManagement")}</label>
        <p className="mt-1 text-2xs text-muted-foreground">
          {t("antigravity.configDescription")}
        </p>
      </div>

      <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
        <div className="space-y-1">
          <label
            className="text-2xs text-muted-foreground"
            htmlFor="antigravity-auth-method"
          >
            {t("antigravity.methodLabel")}
          </label>
          <Select
            onValueChange={(value) => {
              if (!isAuthMethod(value)) return
              markDirty()
              setMethod(value)
            }}
            value={method}
          >
            <SelectTrigger className="h-7 text-xs" id="antigravity-auth-method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTH_METHODS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`antigravity.methods.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-3xs text-muted-foreground">
            {t(`antigravity.methodHints.${method}`)}
          </p>
        </div>

        {method === "gemini-api-key" ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <label
                className="text-2xs text-muted-foreground"
                htmlFor="antigravity-gemini-key"
              >
                {t("antigravity.geminiApiKeyLabel")}
              </label>
              <div className="flex items-center gap-1.5">
                <Input
                  className="h-7 flex-1 text-xs"
                  id="antigravity-gemini-key"
                  onChange={(e) => {
                    markDirty()
                    setGeminiApiKey(e.target.value)
                  }}
                  placeholder="AIza..."
                  type={showKey ? "text" : "password"}
                  value={geminiApiKey}
                />
                <Button
                  className="h-7 w-7 shrink-0"
                  onClick={() => setShowKey((v) => !v)}
                  size="icon"
                  title={
                    showKey ? t("actions.hideApiKey") : t("actions.showApiKey")
                  }
                  type="button"
                  variant="ghost"
                >
                  {showKey ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>
            <div className="space-y-1">
              <label
                className="text-2xs text-muted-foreground"
                htmlFor="antigravity-base-url"
              >
                {t("antigravity.baseUrlLabel")}
              </label>
              <Input
                id="antigravity-base-url"
                className="h-7 text-xs"
                value={baseUrl}
                placeholder="https://api.tokenkey.dev"
                onChange={(e) => {
                  markDirty()
                  setBaseUrl(e.target.value)
                }}
              />
              <p className="text-3xs text-muted-foreground">
                {t("antigravity.baseUrlHint")}
              </p>
            </div>
          </div>
        ) : null}

        {method === "agent-platform" ? (
          <div className="space-y-1">
            <label
              className="text-2xs text-muted-foreground"
              htmlFor="antigravity-google-key"
            >
              {t("antigravity.googleApiKeyLabel")}
            </label>
            <div className="flex items-center gap-1.5">
              <Input
                className="h-7 flex-1 text-xs"
                id="antigravity-google-key"
                onChange={(e) => {
                  markDirty()
                  setGoogleApiKey(e.target.value)
                }}
                placeholder="AIza..."
                type={showKey ? "text" : "password"}
                value={googleApiKey}
              />
              <Button
                className="h-7 w-7 shrink-0"
                onClick={() => setShowKey((v) => !v)}
                size="icon"
                title={
                  showKey ? t("actions.hideApiKey") : t("actions.showApiKey")
                }
                type="button"
                variant="ghost"
              >
                {showKey ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
            <p className="text-3xs text-muted-foreground">
              {t("antigravity.googleApiKeyHint")}
            </p>
          </div>
        ) : null}

        {method === "oauth-business" ||
        (method === "agent-platform" && !googleApiKey.trim()) ? (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label
                className="text-2xs text-muted-foreground"
                htmlFor="antigravity-gcp-project"
              >
                {t("antigravity.gcpProjectLabel")}
              </label>
              <Input
                className="h-7 text-xs"
                id="antigravity-gcp-project"
                onChange={(e) => {
                  markDirty()
                  setGcpProject(e.target.value)
                }}
                placeholder="my-project"
                value={gcpProject}
              />
            </div>
            <div className="space-y-1">
              <label
                className="text-2xs text-muted-foreground"
                htmlFor="antigravity-gcp-location"
              >
                {t("antigravity.gcpLocationLabel")}
              </label>
              <Input
                className="h-7 text-xs"
                id="antigravity-gcp-location"
                onChange={(e) => {
                  markDirty()
                  setGcpLocation(e.target.value)
                }}
                placeholder="global"
                value={gcpLocation}
              />
            </div>
          </div>
        ) : null}

        {incomplete ? (
          <p className="text-2xs text-amber-600 dark:text-amber-400">
            {t(`antigravity.${incomplete}`)}
          </p>
        ) : null}

        {usesBrowserSignIn(method) ? <NativeSignIn /> : null}

        {/* Signing out remains available even with incomplete project fields. */}
        {usesBrowserSignIn(method) ? (
          <SignOut disabled={busy} onSignedOut={onSignedOut} />
        ) : null}

        {/* Keep unsafe native settings merges visible until the next save. */}
        {syncSkip ? (
          <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-2">
            <p className="text-2xs text-amber-600 dark:text-amber-400">
              {t("antigravity.syncSkipped")}
            </p>
            {syncSkip.reason ? (
              <p className="text-3xs text-muted-foreground">
                {syncSkip.reason}
              </p>
            ) : null}
            <code className="block overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-3xs whitespace-nowrap text-muted-foreground">
              {syncSkip.path}
            </code>
          </div>
        ) : null}

        {agent.config_file_path ? (
          <div className="space-y-1">
            <p className="text-3xs text-muted-foreground">
              {t("antigravity.settingsFileHint")}
            </p>
            <code className="block overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-3xs whitespace-nowrap text-muted-foreground">
              {agent.config_file_path}
            </code>
          </div>
        ) : null}

        <LeakedTempSection />

        <div className="flex justify-end">
          <Button
            className="h-7 gap-1.5 px-2.5 text-xs"
            disabled={busy}
            onClick={() => void save()}
            size="sm"
            type="button"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {t("antigravity.save")}
          </Button>
        </div>
      </div>
    </div>
  )
}
