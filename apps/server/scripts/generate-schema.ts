import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeSettingsJsonSchema } from '@llm-proxy/core'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const schemaPath = resolve(scriptDir, '../../../config/settings.schema.json')

await writeSettingsJsonSchema(schemaPath)
