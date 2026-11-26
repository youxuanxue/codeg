// Decides whether Gemini's persistent-429 fallback may continue.
// Loaded only inside the official Gemini process, next to the read_file shim.

export const MAX_MODEL_NOT_FOUND_CONTINUES = 1

export function isUnsupportedModelError(error) {
  if (!error || typeof error !== "object") return false
  if (error.name === "ModelNotFoundError") return true
  return Number(error.status) === 404 || Number(error.code) === 404
}

// "continue": real quota / capacity fallback, unbounded as Gemini already was.
// "continue-once": a ModelNotFound/404 may try one model switch.
// "stop": the next unsupported-model result must surface, not reset `attempt`.
export function persistentFallbackAction(error, priorContinues) {
  if (!isUnsupportedModelError(error)) return "continue"
  const used = Number.isInteger(priorContinues) ? priorContinues : 0
  return used < MAX_MODEL_NOT_FOUND_CONTINUES ? "continue-once" : "stop"
}
