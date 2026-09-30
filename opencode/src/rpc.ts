import { Rpc } from "@opencode/plugin/rpc"

export type FeatureTask = {
  task: string
  branch?: string
  pr?: string
}

export const featuresSchema = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    properties: {
      task: { type: "string", minLength: 1, description: "Assignment for this feature within the inherited full conversation context, including verification and PR requirements" },
      branch: { type: "string", minLength: 1, description: "Existing or new branch name" },
      pr: { type: "string", minLength: 1, description: "Existing open same-repository PR number or URL" },
    },
    required: ["task"],
    additionalProperties: false,
  },
} as const

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
        properties: { branch: { type: "string" }, pr: { type: "string" }, features: featuresSchema, pending: { type: "boolean" } },
        required: ["pending"],
        additionalProperties: false,
      } as const,
    },
  },
})
