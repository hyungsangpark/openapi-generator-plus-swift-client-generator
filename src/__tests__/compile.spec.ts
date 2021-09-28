import { testGenerate } from '@openapi-generator-plus/generator-common/dist/testing'
import { build, prepare, DEFAULT_CONFIG } from './common'
import fs from 'fs'
import path from 'path'
import { configObject } from '@openapi-generator-plus/generator-common'

describe('compile test cases', () => {
	const basePath = path.join(__dirname, '..', '..', '__tests__', 'specs')
	const files = fs.readdirSync(basePath)

	for (const file of files) {
		test(file, async() => {
			const result = await prepare(path.join(basePath, file), {
				...DEFAULT_CONFIG,
				npm: {
					...configObject(DEFAULT_CONFIG, 'npm', {}),
					name: path.basename(file),
				},
				includeTests: true,
			})
			await testGenerate(result, build, path.join('test-output', file))
		})
	}
})
