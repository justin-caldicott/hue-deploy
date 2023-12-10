import os from 'os'
import * as fse from 'fs-extra'
import { Config, configSchema } from './types'

const configPath = `${os.homedir()}/.hue-deploy`

export const readConfig = () =>
  configSchema.parse(
    fse.existsSync(configPath) ? fse.readJSONSync(configPath) : {}
  )

export const writeConfig = (config: Config) => {
  fse.writeJSONSync(configPath, config)
}
