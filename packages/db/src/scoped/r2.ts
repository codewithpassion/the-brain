/**
 * `ScopedR2` — the ONLY way to touch the R2 bucket (PRD §7.3, invariant 1).
 *
 * Prefixes EVERY key with `${p.tenantId}/`. Callers pass tenant-RELATIVE keys (e.g.
 * `docs/${id}`); no method accepts an absolute key (a leading `/` is rejected) so a
 * forgotten prefix — or a key that escapes the tenant's namespace — is impossible.
 * `list` is likewise pinned to the tenant prefix.
 */
import type { Principal } from "@brain/shared"

/** The subset of R2 `put` value types this wrapper accepts. */
export type R2PutBody = ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null

export class ScopedR2 {
  private readonly bucket: R2Bucket
  private readonly p: Principal

  constructor(bucket: R2Bucket, principal: Principal) {
    this.bucket = bucket
    this.p = principal
  }

  /** Tenant-prefix a relative key; reject empty or absolute keys (no escape). */
  private key(key: string): string {
    if (key.length === 0) {
      throw new Error("r2 key required")
    }
    if (key.startsWith("/")) {
      throw new Error("r2 key must be tenant-relative (no leading slash)")
    }
    return `${this.p.tenantId}/${key}`
  }

  put(key: string, value: R2PutBody, options?: R2PutOptions): Promise<R2Object | null> {
    return this.bucket.put(this.key(key), value, options)
  }

  get(key: string): Promise<R2ObjectBody | null> {
    return this.bucket.get(this.key(key))
  }

  head(key: string): Promise<R2Object | null> {
    return this.bucket.head(this.key(key))
  }

  delete(key: string): Promise<void> {
    return this.bucket.delete(this.key(key))
  }

  /** List within the tenant prefix; a caller `prefix` is appended, never replaces it. */
  list(options?: R2ListOptions): Promise<R2Objects> {
    const prefix = `${this.p.tenantId}/${options?.prefix ?? ""}`
    return this.bucket.list({ ...options, prefix })
  }
}
