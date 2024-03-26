import * as fse from 'fs-extra'
import * as YAML from 'yaml'
import got from 'got'
import pluralize from 'pluralize'
import jsonStableStringify from 'json-stable-stringify'
import { Resource, ResourceKind, SensorType, resourceFileSchema } from './types'
import { readConfig } from './config'
import { applyResourceDefaults } from './defaults'
import { paramCase } from 'param-case'

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

  const getFullName = (resource: Pick<Resource, 'kind' | 'name'>) =>
    `/${pluralize(resource.kind)}/${resource.name}`

  const getSensorTypeShortName = (sensorType: SensorType) => {
    const withoutPrefix = sensorType.startsWith('CLIP')
      ? sensorType.substring('CLIP'.length)
      : sensorType.substring('ZHA'.length)
    return paramCase(withoutPrefix)
  }

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
    .map(rsp => Object.entries<any>(JSON.parse(rsp.body))) // TODO: Not any
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

  // Multi-type sensors have the same typed name
  const sensorTypesByTypedName = existingResources.reduce((acc, r) => {
    if (r.resource.kind !== 'sensor') return acc
    const typedName = getFullName(r.resource)
    const types = acc.get(typedName) ?? new Set<SensorType>()
    types.add(r.resource.type)
    acc.set(typedName, types)
    return acc
  }, new Map<string, Set<SensorType>>())

  const getSensorTypes = (resource: Resource) =>
    sensorTypesByTypedName.get(getFullName(resource)) ?? new Set<SensorType>()

  // So we additionally qualify multi-type sensors with the sensor type
  const existingResourcesByFullName = existingResources.reduce((acc, r) => {
    acc.set(
      `${getFullName({
        kind: r.resource.kind,
        name: paramCase(r.resource.name.toLowerCase()),
      })}${
        r.resource.kind === 'sensor' && getSensorTypes(r.resource).size > 1
          ? `:${getSensorTypeShortName(r.resource.type)}`
          : ''
      }`,
      r
    )
    return acc
  }, new Map<string, { id: number; resource: Resource }>())

  const prioritySensorTypes: SensorType[] = ['ZHATemperature', 'ZHAPresence'] // Higher index = higher priority

  // Priority, or single sensor types do not need to be qualified
  // e.g. For a sensor with both temperature and humidity types, "bathroom-temperature-sensor" is enough to reference the temperature type sensor
  const existingPriorityTypeSensorsByShortcutFullName = existingResources
    .filter(
      r =>
        r.resource.kind === 'sensor' &&
        getSensorTypes(r.resource).size > 1 &&
        prioritySensorTypes.indexOf(r.resource.type) ===
          Math.max(
            ...Array.from(getSensorTypes(r.resource)).map(t =>
              prioritySensorTypes.indexOf(t)
            )
          )
    )
    .reduce((acc, r) => {
      acc.set(
        getFullName({
          kind: r.resource.kind,
          name: paramCase(r.resource.name.toLowerCase()),
        }),
        r
      )
      return acc
    }, new Map<string, { id: number; resource: Resource }>())

  const resourceReplacements = [
    ...Array.from(existingResourcesByFullName),
    ...Array.from(existingPriorityTypeSensorsByShortcutFullName),
  ].map(([fullName, r]) => ({
    search: fullName,
    replace: getFullId(r.resource.kind, r.id),
  }))

  const sceneReplacements = existingResources.flatMap(({ id, resource }) =>
    resource.kind === 'group'
      ? resource.scenes.map(s => ({
          search: `/groups/${paramCase(
            resource.name.toLowerCase()
          )}/scenes/${paramCase(s.name.toLowerCase())}`,
          replace: `/groups/${id}/scenes/${s.id}`,
        }))
      : []
  )

  const replacements = [...resourceReplacements, ...sceneReplacements]
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
    acc.set(getFullName(r), r)
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

  const getDeployableResource = (resource: Resource): object => ({
    ...applyResourceDefaults(resource, gatewayApiKey),
    kind: undefined, // hue-deploy specific metadata
  })

  // Apply creates
  // TODO: Test, or probably validate config to prevent, resources of the same kind with the same name
  const createdResources = configResources.filter(
    r => !existingResourcesByFullName.has(getFullName(r))
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
        console.log(`CREATED ${getFullName(r)}: ${getFullId(r.kind, id)}`)
        existingResourcesByFullName.set(getFullName(r), {
          id,
          resource: r,
        })
      } else {
        console.error(
          `FAILED TO CREATE ${getFullName(r)}: ${response.statusCode} ${
            response.body
          } ${deployableResourceJson}`
        )
      }
    }
    console.log() // new line
  }

  // Updates
  const possiblyUpdatedResources = configResources
    .filter(r => existingResourcesByFullName.has(getFullName(r)))
    .filter(r =>
      isOurResource(existingResourcesByFullName.get(getFullName(r))!.resource)
    )

  for (const r of possiblyUpdatedResources) {
    const originalResourceJson = jsonStableStringify({
      ...existingResourcesByFullName.get(getFullName(r))!.resource,
      owner: undefined,
      kind: undefined,
    })
    const deployableResourceJson = jsonStableStringify(getDeployableResource(r))
    if (deployableResourceJson === originalResourceJson) continue

    const url = getUrl(
      r.kind,
      existingResourcesByFullName.get(getFullName(r))!.id
    )
    console.log(`UPDATE ${getFullName(r)}`)
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
        console.log(`UPDATED ${getFullName(r)}`)
      } else {
        console.error(
          `FAILED TO UPDATE ${getFullName(r)}: ${response.statusCode} ${
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
    .filter(r => !configResourcesByFullName.has(getFullName(r.resource)))
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
        console.log(`DELETED ${getFullName(r.resource)}`)
      } else {
        console.error(
          `FAILED TO DELETE ${getFullName(r.resource)}: ${
            response.statusCode
          } ${response.body} ${body}`
        )
      }
    }
  }

  console.log('Done')
}
