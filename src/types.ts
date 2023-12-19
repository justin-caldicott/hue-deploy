import * as z from 'zod'

export const configSchema = z.object({
  gatewayHost: z.string().optional(),
  gatewayApiKey: z.string().optional(),
})

export type Config = z.infer<typeof configSchema>

const baseResourceSchema = z.object({
  name: z.string(),
})

const sensorTypeSchema = z.enum([
  'CLIPAlarm',
  'CLIPBattery',
  'CLIPCarbonMonoxide',
  'CLIPConsumption',
  'CLIPFire',
  'CLIPGenericFlag',
  'CLIPGenericStatus',
  'CLIPHumidity',
  'CLIPLightLevel',
  'CLIPOpenClose',
  'CLIPPower',
  'CLIPPresence',
  'CLIPPressure',
  'CLIPSwitch',
  'CLIPTemperature',
  'CLIPVibration',
  'CLIPWater',
  'ZHAAirQuality',
  'ZHAAlarm',
  'ZHACarbonMonoxide',
  'ZHAConsumption',
  'ZHAFire',
  'ZHAHumidity',
  'ZHALightLevel',
  'ZHAOpenClose',
  'ZHAPower',
  'ZHAPresence',
  'ZHASwitch',
  'ZHAPressure',
  'ZHATemperature',
  'ZHATime',
  'ZHAThermostat',
  'ZHAVibration',
  'ZHAWater',
])

export type SensorType = z.infer<typeof sensorTypeSchema>

export const resourceSchema = z.discriminatedUnion('kind', [
  baseResourceSchema.merge(
    z.object({
      kind: z.literal('light'),
    })
  ),
  baseResourceSchema.merge(
    z.object({
      kind: z.literal('group'),
    })
  ),
  baseResourceSchema.merge(
    z.object({
      kind: z.literal('rule'),
      owner: z.string().min(1).optional(),
      actions: z.array(
        z.object({
          address: z.string().min(1).optional(),
          body: z.record(z.unknown()).optional(),
          method: z.enum(['POST', 'GET', 'PUT', 'PATCH', 'DELETE']).optional(),
        })
      ),
      conditions: z.array(
        z.object({
          address: z.string().min(1),
          operator: z.enum(['eq', 'gt', 'lt', 'dx', 'ddx']),
          value: z.string().min(1).optional(), // dx doesn't need a value
        })
      ),
    })
  ),
  baseResourceSchema.merge(
    z.object({
      kind: z.literal('sensor'),
      manufacturername: z.string().min(1).optional(),
      type: sensorTypeSchema,
    })
  ),
  baseResourceSchema.merge(
    z.object({
      kind: z.literal('schedule'),
      description: z.string().optional(),
      command: z.object({
        address: z.string().min(1),
        body: z.record(z.unknown()).optional(),
        method: z.enum(['POST', 'GET', 'PUT', 'PATCH', 'DELETE']).optional(),
      }),
      localtime: z.string().min(1).optional(),
      time: z.string().min(1).optional(),
    })
  ),
])

export type Resource = z.infer<typeof resourceSchema>

const resourceKindSchema = z.enum([
  'light',
  'group',
  'rule',
  'sensor',
  'schedule',
])
export type ResourceKind = z.infer<typeof resourceKindSchema>

export const resourceFileSchema = z.object({
  resources: z.array(resourceSchema),
})
