import { describe, expect, test } from "bun:test"
import {
  type DeviceFlowDeps,
  pollForToken,
  refreshGrant,
  requestDeviceAuthorization,
  ServerEndpointPendingError,
} from "../src/auth/device"

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** A device-flow deps whose fetch replays a queued response list and whose clock is manual. */
const fakeDeps = (
  responses: Response[],
  options: { sleeps?: number[]; clock?: () => number } = {},
): DeviceFlowDeps => {
  let index = 0
  return {
    fetch: async () => responses[index++] ?? json(400, { error: "authorization_pending" }),
    sleep: async (ms) => {
      options.sleeps?.push(ms)
    },
    now: options.clock ?? (() => 0),
  }
}

describe("device-flow polling state machine (RFC 8628)", () => {
  test("authorization_pending then success yields the grant", async () => {
    const deps = fakeDeps([
      json(400, { error: "authorization_pending" }),
      json(200, { access_token: "at_1", refresh_token: "rt_1", expires_in: 3600 }),
    ])
    const grant = await pollForToken(deps, {
      apiUrl: "https://api.test",
      deviceCode: "dev",
      interval: 5,
      expiresIn: 900,
    })
    expect(grant.accessToken).toBe("at_1")
    expect(grant.refreshToken).toBe("rt_1")
    expect(grant.expiresAt).toBe(3600 * 1000)
  })

  test("slow_down backs the poll interval off by 5s", async () => {
    const sleeps: number[] = []
    const deps = fakeDeps(
      [json(400, { error: "slow_down" }), json(200, { access_token: "at_2", expires_in: 60 })],
      { sleeps },
    )
    await pollForToken(deps, {
      apiUrl: "https://api.test",
      deviceCode: "dev",
      interval: 5,
      expiresIn: 900,
    })
    expect(sleeps).toEqual([5000, 10000])
  })

  test("a terminal error (access_denied) rejects", async () => {
    const deps = fakeDeps([json(400, { error: "access_denied", error_description: "denied" })])
    await expect(
      pollForToken(deps, {
        apiUrl: "https://api.test",
        deviceCode: "dev",
        interval: 1,
        expiresIn: 900,
      }),
    ).rejects.toThrow("denied")
  })

  test("running past expiry rejects with expired_token", async () => {
    let clock = 0
    const deps = fakeDeps([], {
      clock: () => clock,
      sleeps: [],
    })
    deps.sleep = async () => {
      clock += 1000
    }
    deps.fetch = async () => json(400, { error: "authorization_pending" })
    await expect(
      pollForToken(deps, {
        apiUrl: "https://api.test",
        deviceCode: "dev",
        interval: 1,
        expiresIn: 2,
      }),
    ).rejects.toThrow("expired")
  })

  test("a 404 device_authorization surfaces the documented 'endpoint pending' deferral", async () => {
    const deps = fakeDeps([json(404, {})])
    await expect(
      requestDeviceAuthorization(deps, { apiUrl: "https://api.test" }),
    ).rejects.toBeInstanceOf(ServerEndpointPendingError)
  })

  test("requestDeviceAuthorization maps the snake_case body to camelCase", async () => {
    const deps = fakeDeps([
      json(200, {
        device_code: "dev",
        user_code: "WXYZ-1234",
        verification_uri: "https://api.test/device",
        expires_in: 600,
        interval: 5,
      }),
    ])
    const authorization = await requestDeviceAuthorization(deps, { apiUrl: "https://api.test" })
    expect(authorization).toMatchObject({
      deviceCode: "dev",
      userCode: "WXYZ-1234",
      verificationUri: "https://api.test/device",
      interval: 5,
    })
  })

  test("refreshGrant exchanges a refresh token for a fresh grant", async () => {
    const deps = fakeDeps([
      json(200, { access_token: "at_new", refresh_token: "rt_new", expires_in: 30 }),
    ])
    const grant = await refreshGrant(deps, { apiUrl: "https://api.test", refreshToken: "rt_old" })
    expect(grant.accessToken).toBe("at_new")
    expect(grant.refreshToken).toBe("rt_new")
  })
})
