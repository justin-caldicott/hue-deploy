import * as fse from 'fs-extra'
import * as YAML from 'yaml'
import got from 'got'
import pluralize from 'pluralize'
import { paramCase } from 'param-case'
import jsonStableStringify from 'json-stable-stringify'
import {
  Resource,
  ResourceKind,
  UntypedResource,
  resourceFileSchema,
} from './types'
import { readConfig } from './config'
import { applyResourceDefaults } from './defaults'

const OUR_IDENTIFIER = 'hue-deploy'
const OUR_LEGACY_IDENTIFIER = 'deconz-deploy'

export const deploy = async (fromDirectory: string, preview: boolean) => {
  console.log(
    `${preview ? 'preview' : 'deploy'} from directory ${fromDirectory}`
  )

  const config = readConfig()

  if (!config.gatewayHost) {
    throw new Error(
      'Gateway host has not been set. First run the gateway command to set your gateway details.'
    )
  }

  if (!config.gatewayApiKey) {
    throw new Error(
      'Gateway apiKey has not been set. First run the gateway command to set your gateway details.'
    )
  }

  const getUrl = (kind: ResourceKind, id?: number) =>
    `http://${config.gatewayHost}/api/${config.gatewayApiKey}/${pluralize(
      kind
    )}${id ? `/${id}` : ''}`

  const getFullId = (kind: ResourceKind, id: number) =>
    `/${pluralize(kind)}/${id}`

  const getFullName = (kind: ResourceKind, name: string) =>
    `/${pluralize(kind)}/${name}`

  const getResourceFullName = (resource: Resource) =>
    `/${pluralize(resource.kind)}/${resource.name}`

  const kindsToFetch: ResourceKind[] = [
    'light',
    'group',
    'rule',
    'sensor',
    'schedule',
  ]

  const existingResources = (
    await Promise.all(kindsToFetch.map(kind => got.get(getUrl(kind))))
  )
    .map(rsp => Object.entries<UntypedResource>(JSON.parse(rsp.body)))
    .reduce((acc, idResourcePairs, idx) => {
      idResourcePairs.forEach(([id, resource]) => {
        acc.push({
          id: parseInt(id),
          resource: {
            ...resource,
            kind: kindsToFetch[idx],
            created: undefined,
            etag: undefined,
            lasttriggered: undefined,
            timestriggered: undefined,
            config: undefined,
            state: undefined,
          },
        })
      })
      return acc
    }, [] as { id: number; resource: Resource }[])

  // TODO: existingResourcesByFullName doesn't handle that it's possible to have multiple resources with the same name.
  // This tends to happen when using a motion sensor supporting other sensor types as well.
  const existingResourcesByFullName = existingResources.reduce(
    (acc, idResourcePair) => {
      acc.set(
        getFullName(idResourcePair.resource.kind, idResourcePair.resource.name),
        idResourcePair
      )
      return acc
    },
    new Map<string, { id: number; resource: Resource }>()
  )

  // Add aliases for related sensors
  const sensorTypeNames = new Map<string, string>([
    ['ZHATemperature', 'temperature'],
    ['ZHALightLevel', 'light'],
  ])
  const existingSensorResourcesByUniqueId = Array.from(existingResources)
    .filter(
      r => r.resource.kind === 'sensor' && r.resource.type === 'ZHAPresence'
    )
    .reduce((acc, r) => {
      acc.set(r.resource.uniqueid.substring(0, 26), r.resource)
      return acc
    }, new Map<string, Resource>())

  const getMainSensor = (resource: Resource): Resource | null =>
    resource.kind === 'sensor' && sensorTypeNames.has(resource.type)
      ? existingSensorResourcesByUniqueId.get(
          resource.uniqueid.substring(0, 26)
        ) ?? null
      : null

  const replacements = Array.from(existingResources).map(r => {
    const mainSensor = getMainSensor(r.resource)
    const normalizedFullName = `/${pluralize(r.resource.kind)}/${
      // toLowerCase() before paramCase(), to avoid e.g. UM-B1E becoming um-b1-e, should be um-b1e
      mainSensor
        ? `${paramCase(mainSensor.name.toLowerCase())}:${sensorTypeNames.get(
            r.resource.type
          )}`
        : paramCase(r.resource.name.toLowerCase(), {})
    }`
    return {
      search: normalizedFullName,
      replace: getFullId(r.resource.kind, r.id),
    }
  })
  replacements.sort((a, b) => b.search.length - a.search.length)
  replacements.push({ search: 'API_KEY', replace: config.gatewayApiKey })

  const applyReplacements = (yaml: string) => {
    replacements.forEach(({ search, replace }) => {
      yaml = yaml.replace(new RegExp(search, 'g'), replace)
    })
    return yaml
  }

  const configResources = (
    await Promise.all(
      (await fse.readdir(fromDirectory))
        .map(f => `${fromDirectory}/${f}`)
        .map(
          async f =>
            resourceFileSchema.parse(
              YAML.parse(applyReplacements(await fse.readFile(f, 'utf-8')))
            ).resources
        )
    )
  ).reduce((acc, resources) => {
    acc.push(...resources)
    return acc
  }, [])

  const configResourcesByFullName = configResources.reduce((acc, r) => {
    acc.set(getFullName(r.kind, r.name), r)
    return acc
  }, new Map<string, Resource>())

  // Apply our identifier where needed, so we know which resources we manage. Not all resource kinds have owner.
  const markAsOurResource = (resource: Resource) => {
    switch (resource.kind) {
      case 'sensor':
        // TODO: Validate/warn user not providing these in config to avoid overwriting
        resource.manufacturername = OUR_IDENTIFIER
        break
      case 'schedule':
        resource.description = OUR_IDENTIFIER
        break
    }
  }

  configResources.forEach(r => markAsOurResource(r))

  const isOurResource = (r: Resource) =>
    (r.kind === 'rule' && r.owner === config.gatewayApiKey) ||
    (r.kind === 'sensor' &&
      (r.manufacturername === OUR_IDENTIFIER ||
        r.manufacturername === OUR_LEGACY_IDENTIFIER)) ||
    (r.kind === 'schedule' &&
      (r.description === OUR_IDENTIFIER ||
        r.description === OUR_LEGACY_IDENTIFIER))

  const getDeployableResource = (resource: Resource): UntypedResource => ({
    ...applyResourceDefaults(resource),
    kind: undefined, // hue-deploy specific metadata
  })

  // Apply creates
  const createdResources = configResources.filter(
    r => !existingResourcesByFullName.has(getResourceFullName(r))
  )

  for (const r of createdResources) {
    const url = getUrl(r.kind)
    const deployableResourceJson = JSON.stringify(getDeployableResource(r))
    if (preview) {
      console.log('post', url, deployableResourceJson)
    } else {
      const response = await got.post(url, {
        body: deployableResourceJson,
        throwHttpErrors: false,
      })
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body)
        const id = parseInt(body[0].success.id)
        console.log(
          `Created ${getResourceFullName(r)}: ${getFullId(r.kind, id)}`
        )
        existingResourcesByFullName.set(getResourceFullName(r), {
          id,
          resource: r,
        })
      } else {
        console.error(
          `Failed to create ${getResourceFullName(r)}: ${response.statusCode} ${
            response.body
          } ${deployableResourceJson}`
        )
      }
    }
  }

  // Updates
  const updatedResources = configResources
    .filter(r => !createdResources.includes(r))
    .filter(r => existingResourcesByFullName.has(getResourceFullName(r)))
    .filter(r =>
      isOurResource(
        existingResourcesByFullName.get(getResourceFullName(r))!.resource
      )
    )
    .filter(
      r =>
        jsonStableStringify({
          ...existingResourcesByFullName.get(getResourceFullName(r))!.resource,
          owner: undefined,
        }) !== jsonStableStringify(r)
    )
  for (const r of updatedResources) {
    const originalResourceJson = jsonStableStringify({
      ...existingResourcesByFullName.get(getResourceFullName(r))!.resource,
      owner: undefined,
      kind: undefined,
    })
    const deployableResourceJson = jsonStableStringify(getDeployableResource(r))
    if (deployableResourceJson === originalResourceJson) continue

    console.log(
      `Update diff:\n${originalResourceJson}\n${deployableResourceJson}`
    )
    const url = getUrl(
      r.kind,
      existingResourcesByFullName.get(getResourceFullName(r))!.id
    )
    if (preview) {
      console.log('put', url, deployableResourceJson)
    } else {
      const response = await got.put(url, {
        body: deployableResourceJson,
        throwHttpErrors: false,
      })
      if (response.statusCode === 200) {
        console.log(`Updated ${getResourceFullName(r)}`)
      } else {
        console.error(
          `Failed to update ${getResourceFullName(r)}: ${response.statusCode} ${
            response.body
          } ${deployableResourceJson}`
        )
      }
    }
  }

  // Deletes
  const deletedResources = Array.from(existingResourcesByFullName.values())
    .filter(r => isOurResource(r.resource))
    .filter(
      r => !configResourcesByFullName.has(getResourceFullName(r.resource))
    )
  for (const r of deletedResources) {
    const url = getUrl(r.resource.kind, r.id)
    const body = JSON.stringify({ ...r, kind: undefined })
    if (preview) {
      console.log('delete', url, body)
    } else {
      const response = await got.delete(url, {
        body,
        throwHttpErrors: false,
      })
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body)
        const id = parseInt(body[0].success.id)
        console.log(`Deleted ${getResourceFullName(r.resource)}`)
      } else {
        console.error(
          `Failed to delete ${getResourceFullName(r.resource)}: ${
            response.statusCode
          } ${response.body} ${body}`
        )
      }
    }
  }

  console.log('Done')
}
