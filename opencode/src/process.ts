import { spawn } from "node:child_process"

import { CommandError } from "./errors.js"
import type { CommandResult, CommandRunner, CommandSpec } from "./types.js"

export class NodeCommandRunner implements CommandRunner {
  async run(command: CommandSpec): Promise<CommandResult> {
    const result = await new Promise<CommandResult>((resolve) => {
      const child = spawn(command.executable, [...command.args], {
        cwd: command.cwd,
        env: process.env,
        shell: false,
        signal: command.signal,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""

      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk
      })
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk
      })
      child.on("error", (error) => {
        stderr += `${stderr ? "\n" : ""}${error.message}`
        resolve({ stdout, stderr, exitCode: null, signal: null })
      })
      child.on("close", (exitCode, signal) => {
        resolve({ stdout, stderr, exitCode, signal })
      })
    })

    if (result.exitCode !== 0) throw new CommandError(command, result)
    return result
  }
}
