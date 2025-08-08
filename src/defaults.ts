import { Resource } from './types'

// TODO: See if there's a way to make this clearer
export const applyResourceDefaults = (
  resource: Resource,
  gatewayApiKey: string
) => ({
  // Top level defaults
  ...(resource.kind === 'schedule'
    ? {
        activation: 'start',
        time: '', // We use localtime. Empty string will be set if time not specified, but explicit helps comparisons.
        status: 'enabled',
        autodelete: false,
      }
    : {}),
  ...(resource.kind === 'rule' ? { periodic: 0, status: 'enabled' } : {}),
  ...(resource.kind === 'sensor' // We can only be defining virtual sensors
    ? {
        modelid: resource.name,
        swversion: '1.0',
        uniqueid: `hue-deploy::sensor::${resource.name}`,
      }
    : {}),
  ...resource,
  // 1-level down defaults
  ...(resource.kind === 'schedule'
    ? {
        command: {
          method: 'PUT',
          body: {},
          ...{
            ...resource.command,
            ...(resource.command.address &&
            !resource.command.address.startsWith('/api')
              ? {
                  address: `/api/${gatewayApiKey}${resource.command.address}`,
                }
              : {}),
          },
        },
      }
    : {}),
  ...(resource.kind === 'rule'
    ? {
        actions: resource.actions.map((a: object) => ({
          method: 'PUT',
          body: {},
          ...a,
        })),
      }
    : {}),
})
