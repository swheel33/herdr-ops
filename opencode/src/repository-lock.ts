import { mkdir } from "node:fs/promises"
import path from "node:path"

import { lock } from "proper-lockfile"

import { DispatchError } from "./errors.js"

export const REPOSITORY_LOCK_STALE_MS = 30 * 60 * 1_000

function isLockHeld(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ELOCKED"
}

export function withRepositoryLock<T>(commonDir: string, action: () => Promise<T>): Promise<T>
export function withRepositoryLock<T>(
  commonDir: string,
  action: () => Promise<T>,
  options: { skipIfLocked: true },
): Promise<T | undefined>
export async function withRepositoryLock<T>(
  commonDir: string,
  action: () => Promise<T>,
  options?: { skipIfLocked?: boolean },
): Promise<T | undefined> {
  const stateDirectory = path.join(commonDir, "opencode-herdr-dispatch")
  const lockPath = path.join(stateDirectory, "dispatch")
  await mkdir(stateDirectory, { recursive: true })

  let release: (() => Promise<void>) | undefined
  try {
    release = await lock(lockPath, {
      realpath: false,
      retries: 0,
      stale: REPOSITORY_LOCK_STALE_MS,
    })
  } catch (error) {
    if (isLockHeld(error)) {
      if (options?.skipIfLocked) return undefined
      throw new DispatchError("Another dispatch or repository maintenance operation is in progress.")
    }
    throw error
  }

  try {
    return await action()
  } finally {
    await release()
  }
}
