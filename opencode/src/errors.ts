import type { CommandResult, CommandSpec } from "./types.js"
import type { DispatchPartialState } from "./types.js"

const OUTPUT_LIMIT = 4_000

function usefulOutput(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return "<empty>"
  return trimmed.length > OUTPUT_LIMIT
    ? `${trimmed.slice(0, OUTPUT_LIMIT)}... <truncated>`
    : trimmed
}

export function formatCommandFailure(
  command: CommandSpec,
  result: CommandResult,
): string {
  const redacted = new Set(command.redactArgs ?? [])
  const args = command.args.map((arg, index) =>
    redacted.has(index) ? "<redacted>" : JSON.stringify(arg),
  )
  const termination =
    result.signal === null
      ? `exit status ${String(result.exitCode)}`
      : `signal ${result.signal}`

  return [
    `Command failed: ${command.executable} ${args.join(" ")}`,
    `Termination: ${termination}`,
    `stdout: ${usefulOutput(result.stdout)}`,
    `stderr: ${usefulOutput(result.stderr)}`,
  ].join("\n")
}

export class DispatchError extends Error {
  readonly partial: DispatchPartialState | undefined

  constructor(
    message: string,
    options?: ErrorOptions & { partial?: DispatchPartialState },
  ) {
    super(message, options)
    this.name = "DispatchError"
    this.partial = options?.partial
  }
}

export class CommandError extends DispatchError {
  readonly command: CommandSpec
  readonly result: CommandResult

  constructor(command: CommandSpec, result: CommandResult) {
    super(formatCommandFailure(command, result))
    this.name = "CommandError"
    this.command = command
    this.result = result
  }
}
