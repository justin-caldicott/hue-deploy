import * as z from 'zod'

export const configSchema = z.object({
  gatewayHost: z.string().optional(),
  gatewayApiKey: z.string().optional(),
})

export type Config = z.infer<typeof configSchema>

export const resourceKindSchema = z.union([
  z.literal('light'),
  z.literal('group'),
  z.literal('rule'),
  z.literal('sensor'),
  z.literal('schedule'),
])

export type ResourceKind = z.infer<typeof resourceKindSchema>

export const resourceSchema = z
  .object({
    kind: resourceKindSchema,
    name: z.string(),
  })
  .nonstrict()

export type Resource = z.infer<typeof resourceSchema>

const untypedResourceSchema = resourceSchema.omit({ kind: true })
export type UntypedResource = z.infer<typeof untypedResourceSchema>

export const resourceFileSchema = z.object({
  resources: z.array(resourceSchema),
})
