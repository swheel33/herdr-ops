import { Rpc } from "@opencode/plugin/rpc"

export const Feature = Rpc.define({
  id: "herdr-feature",
  events: {},
  methods: {
    take: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      } as const,
      output: {
        type: "object",
        properties: { branch: { type: "string" }, pr: { type: "string" }, pending: { type: "boolean" } },
        required: ["pending"],
        additionalProperties: false,
      } as const,
    },
  },
})
