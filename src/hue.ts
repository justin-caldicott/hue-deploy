#!/usr/bin/env node

import { Command } from 'commander'
import { deploy } from './deploy'
import { readConfig, writeConfig } from './config'
import { backup } from './backup'

const program = new Command()

program
  .version(require('../package.json').version)
  .description(
    'Simple command line deployment for Hue automations and resources.'
  )

program
  .command('deploy')
  .description(
    'deploy resources defined in the current directory to a hue gateway'
  )
  .option('-f, --from <directory>', 'specific directory to deploy from')
  .action(options => deploy(options.from ?? process.cwd(), false))

program
  .command('preview')
  .description(
    'preview deployment of resources defined in the current directory to a hue gateway'
  )
  .option('-f, --from <directory>', 'specific directory to preview deploy for')
  .action(options => deploy(options.from ?? process.cwd(), true))

program
  .command('backup')
  .description('make a local backup of the hue gateway configuration')
  .action(options => backup())

const gateway = program
  .command('gateway')
  .description('manage the gateway used for deployment')

gateway
  .command('set <host> <apiKey>')
  .description('set the gateway to deploy to')
  .action((host: string, apiKey: string) => {
    writeConfig({ ...readConfig(), gatewayHost: host, gatewayApiKey: apiKey })
  })

gateway
  .command('get')
  .description('get the gateway to deploy to')
  .action(() => {
    const { gatewayHost, gatewayApiKey } = readConfig()
    const gateway = {
      host: gatewayHost,
      apiKey: gatewayApiKey
        ? `${gatewayApiKey.substring(0, 4)}********`
        : undefined,
    }
    console.log(JSON.stringify(gateway))
  })

program.parse(process.argv)
