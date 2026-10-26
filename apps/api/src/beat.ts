/**
 * Control-plane job heartbeat. Copied into each repo, keep the copies identical.
 * Beats are off when HB_URL or HB_TOKEN is missing. With an HB_SERVICE binding they
 * go through it, because a Worker cannot fetch another Worker's custom domain in
 * the same zone. A beat never throws and never waits longer than 3 s, so monitoring
 * cannot change a job's outcome. redirect is "manual" because workerd rejects "error".
 */
export interface BeatEnv {
  HB_SERVICE?: { fetch: (request: Request) => Promise<Response> }
  HB_TOKEN?: string
  HB_URL?: string
}

export interface BeatContext {
  waitUntil(promise: Promise<unknown>): void
}

export type BeatPhase = "start" | "success" | "fail"

const TIMEOUT_MS = 15_000
const TRAILING_SLASHES = /\/+$/

async function send(
  env: BeatEnv,
  systemId: string,
  phase: BeatPhase,
  message: string | undefined,
): Promise<void> {
  try {
    const url = `${(env.HB_URL ?? "").replace(TRAILING_SLASHES, "")}/hb/${systemId}/${phase}`
    const init: RequestInit = {
      body: JSON.stringify(message ? { message: message.slice(0, 500) } : {}),
      headers: {
        Authorization: `Bearer ${env.HB_TOKEN}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
    const response = env.HB_SERVICE
      ? await env.HB_SERVICE.fetch(new Request(url, init))
      : await fetch(url, init)
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
