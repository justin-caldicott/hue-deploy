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

  const gatewayApiKey = config.gatewayApiKey

  const getUrl = (kind: ResourceKind, id?: number) =>
    `http://${config.gatewayHost}/api/${gatewayApiKey}/${pluralize(kind)}${
      id ? `/${id}` : ''
    }`

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

  const applyReplacements = (yaml: string) => {
    replacements.forEach(({ search, replace }) => {
      yaml = yaml.replace(new RegExp(search, 'g'), replace)
    })
    return yaml
  }

  const configResources = (
    await Promise.all(
      (
        await fse.readdir(fromDirectory)
      )
        .filter(
          f =>
            f.toLowerCase().endsWith('.yml') ||
            f.toLowerCase().endsWith('.yaml')
        )
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
    (r.kind === 'rule' && r.owner === gatewayApiKey) ||
    (r.kind === 'sensor' && r.manufacturername === OUR_IDENTIFIER) ||
    (r.kind === 'schedule' && r.description === OUR_IDENTIFIER)

  const getDeployableResource = (resource: Resource): UntypedResource => ({
    ...applyResourceDefaults(resource, gatewayApiKey),
    kind: undefined, // hue-deploy specific metadata
  })

  // Apply creates
  const createdResources = configResources.filter(
    r => !existingResourcesByFullName.has(getResourceFullName(r))
  )

  for (const r of createdResources) {
    const url = getUrl(r.kind)
    const deployableResourceJson = JSON.stringify(getDeployableResource(r))

    console.log(`CREATE ${r.kind}`)
    console.log(`AFTER  ${deployableResourceJson}`)

    if (preview) {
      console.log(`POST   ${url} ${deployableResourceJson}`)
    } else {
      const response = await got.post(url, {
        body: deployableResourceJson,
        throwHttpErrors: false,
      })
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body)
        const id = parseInt(body[0].success.id)
        console.log(
          `CREATED ${getResourceFullName(r)}: ${getFullId(r.kind, id)}`
        )
        existingResourcesByFullName.set(getResourceFullName(r), {
          id,
          resource: r,
        })
      } else {
        console.error(
          `FAILED TO CREATE ${getResourceFullName(r)}: ${response.statusCode} ${
            response.body
          } ${deployableResourceJson}`
        )
      }
    }
    console.log() // new line
  }

  // Updates
  const possiblyUpdatedResources = configResources
    .filter(r => existingResourcesByFullName.has(getResourceFullName(r)))
    .filter(r =>
      isOurResource(
        existingResourcesByFullName.get(getResourceFullName(r))!.resource
      )
    )

  for (const r of possiblyUpdatedResources) {
    const originalResourceJson = jsonStableStringify({
      ...existingResourcesByFullName.get(getResourceFullName(r))!.resource,
      owner: undefined,
      kind: undefined,
    })
    const deployableResourceJson = jsonStableStringify(getDeployableResource(r))
    if (deployableResourceJson === originalResourceJson) continue

    const url = getUrl(
      r.kind,
      existingResourcesByFullName.get(getResourceFullName(r))!.id
    )
    console.log(`UPDATE ${getResourceFullName(r)}`)
    console.log(`BEFORE ${originalResourceJson}`)
    console.log(`AFTER  ${deployableResourceJson}`)
    if (preview) {
      console.log(`PUT    ${url} ${deployableResourceJson}`)
    } else {
      const response = await got.put(url, {
        body: deployableResourceJson,
        throwHttpErrors: false,
      })
      if (response.statusCode === 200) {
        console.log(`UPDATED ${getResourceFullName(r)}`)
      } else {
        console.error(
          `FAILED TO UPDATE ${getResourceFullName(r)}: ${response.statusCode} ${
            response.body
          }`
        )
      }
    }
    console.log() // new line
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
      console.log(`DELETE ${url} ${body}\n`)
    } else {
      const response = await got.delete(url, {
        body,
        throwHttpErrors: false,
      })
      if (response.statusCode === 200) {
        const body = JSON.parse(response.body)
        const id = parseInt(body[0].success.id)
        console.log(`DELETED ${getResourceFullName(r.resource)}`)
      } else {
        console.error(
          `FAILED TO DELETE ${getResourceFullName(r.resource)}: ${
            response.statusCode
          } ${response.body} ${body}`
        )
      }
    }
  }

  console.log('Done')
}
