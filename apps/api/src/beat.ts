/**
 * Control-plane job heartbeat. Copied into each repo, keep the copies identical.
 * Beats are off when HB_URL or HB_TOKEN is missing. A beat never throws and
 * never waits longer than 3 s, so monitoring cannot change a job's outcome.
 */
export interface BeatEnv {
  HB_TOKEN?: string
  HB_URL?: string
}

export interface BeatContext {
  waitUntil(promise: Promise<unknown>): void
}

export type BeatPhase = "start" | "success" | "fail"

const TIMEOUT_MS = 3000
const TRAILING_SLASHES = /\/+$/

async function send(
  env: BeatEnv,
  systemId: string,
  phase: BeatPhase,
  message: string | undefined,
): Promise<void> {
  try {
    const response = await fetch(
      `${(env.HB_URL ?? "").replace(TRAILING_SLASHES, "")}/hb/${systemId}/${phase}`,
      {
        body: JSON.stringify(message ? { message: message.slice(0, 500) } : {}),
        headers: {
          Authorization: `Bearer ${env.HB_TOKEN}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    )
    await response.body?.cancel()
  } catch {
    // Swallowed on purpose. Fetch errors can carry request details.
  }
}

/** Fire one beat through ctx.waitUntil. Does nothing when config is missing. */
export function beat(
  env: BeatEnv,
  ctx: BeatContext,
  systemId: string,
  phase: BeatPhase,
  message?: string,
): void {
  if (!(env.HB_URL && env.HB_TOKEN)) {
    return
  }
  try {
    ctx.waitUntil(send(env, systemId, phase, message))
  } catch {
    // waitUntil can throw once the invocation has ended.
  }
}

/** start, then success or fail around a job. A failure is rethrown unchanged. */
export async function withBeat<T>(
  env: BeatEnv,
  ctx: BeatContext,
  systemId: string,
  job: () => Promise<T>,
): Promise<T> {
  beat(env, ctx, systemId, "start")
  try {
    const result = await job()
    beat(env, ctx, systemId, "success")
    return result
  } catch (error) {
    beat(env, ctx, systemId, "fail", error instanceof Error ? error.name : "job failed")
    throw error
  }
}
