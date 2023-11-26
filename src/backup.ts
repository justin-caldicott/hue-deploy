import got from 'got'
import { readConfig } from './config'
import * as fse from 'fs-extra'

export const backup = async () => {
  const config = readConfig()

  const exportResponse = await got.post(
    `http://${config.gatewayHost}/api/${config.gatewayApiKey}/config/export`
  )

  got
    .stream(`http://${config.gatewayHost}/deCONZ.tar.gz`)
    .pipe(
      fse.createWriteStream(`./gateway-backup-${new Date().toISOString()}.zip`)
    )
}
