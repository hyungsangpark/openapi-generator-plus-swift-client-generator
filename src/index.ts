import { CodegenSchemaType, CodegenGeneratorContext, CodegenGenerator, CodegenConfig, CodegenDocument, CodegenAllOfStrategy, CodegenAnyOfStrategy, CodegenOneOfStrategy, CodegenLogLevel, isCodegenInterfaceSchema, isCodegenObjectSchema, CodegenSchemaPurpose, CodegenGeneratorType, isCodegenEnumSchema, isCodegenWrapperSchema, isCodegenOneOfSchema, isCodegenHierarchySchema, CodegenNativeType } from '@openapi-generator-plus/types'
import { CodegenOptionsSwift } from './types'
import path from 'path'
import Handlebars from 'handlebars'
import { loadTemplates, emit, registerStandardHelpers } from '@openapi-generator-plus/handlebars-templates'
import { javaLikeGenerator, ConstantStyle, JavaLikeContext, options as javaLikeOptions, EnumMemberStyle } from '@openapi-generator-plus/java-like-generator-helper'
import { commonGenerator, configBoolean, configObject, configString, configStringArray, debugStringify } from '@openapi-generator-plus/generator-common'
import { promises as fs } from 'fs'

export { CodegenOptionsSwift as CodegenOptionsTypeScript } from './types'

function escapeString(value: string | number | boolean) {
	if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
		throw new Error(`escapeString called with unsupported type: ${typeof value} (${value})`)
	}

	value = String(value)
	value = value.replace(/\\/g, '\\\\')
	value = value.replace(/"/g, '\\"')
	value = value.replace(/\r/g, '\\r')
	value = value.replace(/\n/g, '\\n')
	return value
}

function computeCustomTemplatesPath(configPath: string | undefined, customTemplatesPath: string) {
	if (configPath) {
		return path.resolve(path.dirname(configPath), customTemplatesPath) 
	} else {
		return customTemplatesPath
	}
}

function toSafeTypeForComposing(nativeType: string): string {
	return nativeType
}

export interface SwiftGeneratorContext extends CodegenGeneratorContext {
	loadAdditionalTemplates?: (hbs: typeof Handlebars) => Promise<void>
	additionalWatchPaths?: () => string[]
	additionalExportTemplates?: (outputPath: string, doc: CodegenDocument, hbs: typeof Handlebars, rootContext: Record<string, unknown>) => Promise<void>
	additionalCleanPathPatterns?: () => string[]
}

export function chainSwiftGeneratorContext(base: SwiftGeneratorContext, add: Partial<SwiftGeneratorContext>): SwiftGeneratorContext {
	const result: SwiftGeneratorContext = {
		...base,
		loadAdditionalTemplates: async function(hbs) {
			/* Load the additional first, so that earlier contexts in the chain have priority */
			if (add.loadAdditionalTemplates) {
				await add.loadAdditionalTemplates(hbs)
			}
			if (base.loadAdditionalTemplates) {
				await base.loadAdditionalTemplates(hbs)
			}
		},
		additionalWatchPaths: function() {
			const result: string[] = []
			if (base.additionalWatchPaths) {
				result.push(...base.additionalWatchPaths())
			}
			if (add.additionalWatchPaths) {
				result.push(...add.additionalWatchPaths())
			}
			return result
		},
		additionalExportTemplates: async function(outputPath, doc, hbs, rootContext) {
			if (base.additionalExportTemplates) {
				await base.additionalExportTemplates(outputPath, doc, hbs, rootContext)
			}
			if (add.additionalExportTemplates) {
				await add.additionalExportTemplates(outputPath, doc, hbs, rootContext)
			}
		},
	}
	return result
}

/* https://openapi-generator.tech/docs/generators/swift5 */
const RESERVED_WORDS = [
	'Any', 'AnyObject', 'Array', 'Bool', 'COLUMN', 'Character', 'Class', 'ClosedRange', 'Codable', 'CountableClosedRange', 'CountableRange', 'Data', 'Decodable', 'Dictionary',
	'Double', 'Encodable', 'Error', 'ErrorResponse', 'FILE', 'FUNCTION', 'Float', 'Float32', 'Float64', 'Float80', 'Int', 'Int16', 'Int32', 'Int64', 'Int8', 'LINE', 'OptionSet',
	'Optional', 'Protocol', 'Range', 'Response', 'Self', 'Set', 'StaticString', 'String', 'Type', 'UInt', 'UInt16', 'UInt32', 'UInt64', 'UInt8', 'URL', 'Unicode', 'Void', '_',
	'as', 'associatedtype', 'associativity', 'break', 'case', 'catch', 'class', 'continue', 'convenience', 'default', 'defer', 'deinit', 'didSet', 'do', 'dynamic', 'dynamicType',
	'else', 'enum', 'extension', 'fallthrough', 'false', 'fileprivate', 'final', 'for', 'func', 'get', 'guard', 'if', 'import', 'in', 'indirect', 'infix', 'init', 'inout',
	'internal', 'is', 'lazy', 'left', 'let', 'mutating', 'nil', 'none', 'nonmutating', 'open', 'operator', 'optional', 'override', 'postfix', 'precedence', 'prefix', 'private',
	'protocol', 'public', 'repeat', 'required', 'rethrows', 'return', 'right', 'self', 'set', 'static', 'struct', 'subscript', 'super', 'switch', 'throw', 'throws', 'true',
	'try', 'typealias', 'unowned', 'var', 'weak', 'where', 'while', 'willSet', 'Sendable', 'Hashable',
	'LocalDate', 'LocalTime', 'OffsetDateTime', 'Decimal', 'String', 'Void', 'File', 'FormData',
	'unknown', // for our enum cases
	'RetryConfiguration', 'Configuration',
	'SecurityClient', 'SecurityClientController', 'SecurityScheme', 'OAuthPasswordFlowClient', 'OAuthClientCredentialsFlowClient', 'OAuthAuthorizationCodeFlowClient', 
	'OAuthAccessTokenManager', 'AccessTokenHandler', 'OAuthAccessToken', 'BasicAuthenticationSecurityClient', 'APIKeySecurityClient', 'AbstractOAuthFlowClient',
	'OAuthConfiguration',
]

export function options(config: CodegenConfig, context: SwiftGeneratorContext): CodegenOptionsSwift {
	const pkg = configObject(config, 'package', {})
	const packageName = configString(pkg, 'name', 'Api', 'package.')
	const defaultRelativeSourceOutputPath = `Sources/${packageName}`
	
	const relativeSourceOutputPath = configString(config, 'relativeSourceOutputPath', defaultRelativeSourceOutputPath)
	const customTemplates = configString(config, 'customTemplates', undefined)

	const logging = configObject(config, 'logging', {})

	const options: CodegenOptionsSwift = {
		...javaLikeOptions(config, createJavaLikeContext(context)),
		relativeSourceOutputPath,
		customTemplatesPath: customTemplates ? computeCustomTemplatesPath(config.configPath, customTemplates) : null,
		hideGenerationTimestamp: configBoolean(config, 'hideGenerationTimestamp', false),
		additionalRetryStatusCodes: configStringArray(config, 'additionalRetryStatusCodes', []),
		additionalTokenFailureStatusCodes: configStringArray(config, 'additionalTokenFailureStatusCodes', []),
		package: {
			name: packageName,
		},
		logging: {
			subsystem: configString(logging, 'subsystem', packageName, 'logging.'),
		},
	}

	return options
}

function createJavaLikeContext(context: SwiftGeneratorContext): JavaLikeContext {
	const javaLikeContext: JavaLikeContext = {
		...context,
		reservedWords: () => RESERVED_WORDS,
		defaultConstantStyle: ConstantStyle.camelCase,
		defaultEnumMemberStyle: EnumMemberStyle.constant,
	}
	return javaLikeContext
}


export default function createGenerator(config: CodegenConfig, context: SwiftGeneratorContext): CodegenGenerator {
	const generatorOptions = options(config, context)

	const baseGenerator = context.baseGenerator(config, context)
	const aCommonGenerator = commonGenerator(config, context)
	return {
		...baseGenerator,
		...aCommonGenerator,
		...javaLikeGenerator(config, createJavaLikeContext(context)),
		toLiteral: (value, options) => {
			if (value === undefined) {
				const defaultValue = context.generator().defaultValue(options)
				if (defaultValue === null) {
					return null
				}
				return defaultValue.literalValue
			}
			if (value === null) {
				return 'nil'
			}

			const { type, format, schemaType } = options

			if (schemaType === CodegenSchemaType.ENUM) {
				return `${options.nativeType.concreteType}.${context.generator().toEnumMemberName(String(value))}`
			}

			switch (type) {
				case 'integer': {
					return `${value}`
				}
				case 'number': {
					return `${value}`
				}
				case 'string': {
					if (format === 'date') {
						return `DateFormatter.ISO8601DATE.date(from: "${value}")`
					} else if (format === 'time') {
						return `DateFormatter.ISO8601TIME.date(from: "${value}")`
					} else if (format === 'date-time') {
						return `DateFormatter.ISO8601DATETIME.date(from: "${value}")`
					} else if (format === 'binary') {
						return `"${escapeString(String(value))}".data(using: .utf8)!`
					} else {
						return `"${escapeString(String(value))}"`
					}
				}
				case 'boolean':
					return `${value}`
				case 'object':
				case 'anyOf':
				case 'oneOf':
					context.log(CodegenLogLevel.WARN, `Literal value of type ${typeof value} is unsupported for schema type object: ${debugStringify(value)}`)
					return 'nil'
				case 'file':
					throw new Error(`Cannot format literal for type ${type}`)
				case 'array': {
					const arrayValue = Array.isArray(value) ? value : [value]
					const component = options.component
					if (!component) {
						throw new Error(`toLiteral cannot format array literal without a component type: ${value}`)
					}
					return `[${arrayValue.map(v => context.generator().toLiteral(v, { ...component.schema, ...component })).join(', ')}]`
				}
			}

			throw new Error(`Unsupported type name: ${type}`)
		},
		toNativeType: (options) => {
			const { schemaType, format } = options

			/* See https://github.com/OAI/OpenAPI-Specification/blob/master/versions/2.0.md#data-types */
			switch (schemaType) {
				case CodegenSchemaType.INTEGER: {
					if (!format) {
						return new context.NativeType('Int')
					} else if (format === 'int32') {
						return new context.NativeType('Int32')
					} else if (format === 'int64') {
						return new context.NativeType('Int64')
					} else {
						throw new Error(`Unsupported integer format: ${format}`)
					}
				}
				case CodegenSchemaType.NUMBER: {
					if (!format) {
						return new context.NativeType('Decimal')
					} else if (format === 'float') {
						return new context.NativeType('Float')
					} else if (format === 'double') {
						return new context.NativeType('Double')
					} else {
						throw new Error(`Unsupported number format: ${format}`)
					}
				}
				case CodegenSchemaType.DATE:
					return new context.NativeType('LocalDate')
				case CodegenSchemaType.TIME:
					return new context.NativeType('LocalTime')
				case CodegenSchemaType.DATETIME:
					return new context.NativeType('OffsetDateTime')
				case CodegenSchemaType.STRING:
					if (format === 'url') {
						return new context.NativeType('URL')
					} else {
						return new context.NativeType('String')
					}
				case CodegenSchemaType.BOOLEAN:
					return new context.NativeType('Bool')
				case CodegenSchemaType.BINARY:
					return new context.NativeType('Data')
				case CodegenSchemaType.FILE:
					return new context.NativeType('File')
				case CodegenSchemaType.ANY:
					return new context.NativeType('Any')
			}

			throw new Error(`Unsupported schema type: ${schemaType}`)
		},
		toNativeObjectType: function(options) {
			const { scopedName } = options
			let modelName = generatorOptions.package.name
			for (const name of scopedName) {
				modelName += `.${context.generator().toClassName(name)}`
			}
			return new context.NativeType(modelName)
		},
		toNativeArrayType: (options) => {
			const { componentNativeType } = options
			return new context.TransformingNativeType(componentNativeType, {
				default: (nativeType) => `[${toSafeTypeForComposing(nativeType.componentType ? nativeType.componentType.nativeType : nativeType.nativeType)}]`,
			})
		},
		toNativeMapType: (options) => {
			const { keyNativeType, componentNativeType } = options
			return new context.ComposingNativeType([keyNativeType, componentNativeType], {
				default: (nativeTypes) => {
					return `[${nativeTypes[0].componentType ? nativeTypes[0].componentType.nativeType : nativeTypes[0].nativeType} : ${nativeTypes[1].componentType ? nativeTypes[1].componentType.nativeType : nativeTypes[1].nativeType}]`
				},
			})
		},
		nativeTypeUsageTransformer: ({ nullable, required }) => ({
			default: function(nativeType, nativeTypeString) {
				if (nullable) {
					nativeTypeString = `Nullable<${toSafeTypeForComposing(nativeTypeString)}>`
				}
				if (!required) {
					nativeTypeString = `${toSafeTypeForComposing(nativeTypeString)}?`
				}

				return nativeTypeString
			},
			/* We don't transform the concrete type as the concrete type is never null; we use it to make new objects */
			concreteType: null,
			parentType: null,
		}),
		toSuggestedSchemaName: (name, options) => {
			if (options.schemaType === CodegenSchemaType.ENUM) {
				name = `${name}`
			} else if (options.purpose === CodegenSchemaPurpose.INTERFACE) {
				name = `${name}_protocol`
			} else if (options.purpose === CodegenSchemaPurpose.ABSTRACT_IMPLEMENTATION) {
				name = `abstract_${name}`
			} else if (options.purpose === CodegenSchemaPurpose.IMPLEMENTATION) {
				name = `${name}_impl`
			}
			return name
		},
		defaultValue: (options) => {
			const { schemaType, required } = options

			if (!required) {
				return { value: null, literalValue: 'nil' }
			}

			switch (schemaType) {
				case CodegenSchemaType.NUMBER: {
					const literalValue = context.generator().toLiteral(0.0, options)
					if (literalValue === null) {
						return null
					}
					return { value: 0.0, literalValue }
				}
				case CodegenSchemaType.INTEGER: {
					const literalValue = context.generator().toLiteral(0, options)
					if (literalValue === null) {
						return null
					}
					return { value: 0, literalValue }
				}
				case CodegenSchemaType.BOOLEAN:
					return { value: false, literalValue: 'false' }
				case CodegenSchemaType.ARRAY:
					return { value: [], literalValue: '[]' }
				case CodegenSchemaType.MAP:
					return { value: {}, literalValue: '[:]' }
				default:
					return null
			}
		},
		initialValue: (options) => {
			const { required, defaultValue } = options

			/*
			  Default values in the spec are intended to be applied when a client or server receives a
			  response or request, respectively, and values are missing.

			  This implementation means that properties with defaults will get those default values as
			  their initial value, meaning that any properties that are omitted in the _received_ request or
			  response will have the default value.

			  TODO But it also means that any requests or responses _sent_ will _also_ have the default values,
			  rather than omitting the property and letting the receiving side apply the default value. This
			  is NOT according to the spec and should be fixed.
			 */
			if (defaultValue) {
				return defaultValue
			}

			if (!required) {
				return null
			}

			/* For required fields, we initialise them with whatever their default value should be */
			return context.generator().defaultValue(options)
		},
		operationGroupingStrategy: () => {
			return context.operationGroupingStrategies.addToGroupsByTagOrPath
		},
		allOfStrategy: () => CodegenAllOfStrategy.HIERARCHY,
		anyOfStrategy: () => CodegenAnyOfStrategy.OBJECT,
		oneOfStrategy: () => CodegenOneOfStrategy.NATIVE,
		supportsInheritance: () => false,
		supportsMultipleInheritance: () => false, /* As we use structs not classes */
		nativeCompositionCanBeScope: () => true,
		nativeComposedSchemaRequiresName: () => true, /* So we can name our enum cases */
		nativeComposedSchemaRequiresObjectLikeOrWrapper: () => false,
		interfaceCanBeNested: () => false,

		watchPaths: () => {
			const result = [path.resolve(__dirname, '..', 'templates')]
			if (context.additionalWatchPaths) {
				result.push(...context.additionalWatchPaths())
			}
			if (generatorOptions.customTemplatesPath) {
				result.push(generatorOptions.customTemplatesPath)
			}
			return result
		},
		
		generatorType: () => CodegenGeneratorType.CLIENT,

		cleanPathPatterns: () => {
			const relativeSourceOutputPath = generatorOptions.relativeSourceOutputPath
			
			const result = [
				path.join(relativeSourceOutputPath, 'Models', '*.swift'),
				path.join(relativeSourceOutputPath, 'APIs', '*Api.swift'),
				path.join(relativeSourceOutputPath, 'Support', '*.swift'),
			]
			if (context.additionalCleanPathPatterns) {
				result.push(...context.additionalCleanPathPatterns())
			}
			return result
		},

		templateRootContext: () => {
			return {
				...aCommonGenerator.templateRootContext(),
				...generatorOptions,
				generatorClass: '@openapi-generator-plus/swift-client-generator',
			}
		},

		exportTemplates: async(outputPath, doc) => {
			const hbs = Handlebars.create()

			registerStandardHelpers(hbs, context)

			await loadTemplates(path.resolve(__dirname, '..', 'templates'), hbs)
			if (context.loadAdditionalTemplates) {
				await context.loadAdditionalTemplates(hbs)
			}

			if (generatorOptions.customTemplatesPath) {
				await loadTemplates(generatorOptions.customTemplatesPath, hbs)
			}

			const rootContext = context.generator().templateRootContext()
			
			const relativeSourceOutputPath = generatorOptions.relativeSourceOutputPath

			for (const group of doc.groups) {
				const operations = group.operations
				if (!operations.length) {
					continue
				}
	
				await emit('api', path.join(outputPath, relativeSourceOutputPath, 'APIs', `${context.generator().toClassName(group.name)}Api.swift`), 
					{ ...rootContext, ...group, operations, servers: doc.servers }, true, hbs)
			}

			for (const schema of context.utils.values(doc.schemas)) {
				if (isCodegenObjectSchema(schema)) {
					await emit('pojo', path.join(outputPath, relativeSourceOutputPath, 'Models', `${context.generator().toClassName(schema.name)}.swift`), 
						{ ...rootContext, pojo: schema }, true, hbs)
				} else if (isCodegenEnumSchema(schema)) {
					await emit('enum', path.join(outputPath, relativeSourceOutputPath, 'Models', `${context.generator().toClassName(schema.name)}.swift`), 
						{ ...rootContext, enum: schema }, true, hbs)
				} else if (isCodegenInterfaceSchema(schema)) {
					await emit('interface', path.join(outputPath, relativeSourceOutputPath, 'Models', `${context.generator().toClassName(schema.name)}.swift`), 
						{ ...rootContext, interface: schema }, true, hbs)
				} else if (isCodegenHierarchySchema(schema)) {
					await emit('hierarchy', path.join(outputPath, relativeSourceOutputPath, 'Models', `${context.generator().toClassName(schema.name)}.swift`), 
						{ ...rootContext, hierarchy: schema }, true, hbs)
				} else if (isCodegenWrapperSchema(schema)) {
					await emit('wrapper', path.join(outputPath, relativeSourceOutputPath, 'Models', `${context.generator().toClassName(schema.name)}.swift`), 
						{ ...rootContext, schema }, true, hbs)
				} else if (isCodegenOneOfSchema(schema)) {
					await emit('oneOf', path.join(outputPath, relativeSourceOutputPath, 'Models', `${context.generator().toClassName(schema.name)}.swift`), 
						{ ...rootContext, oneOf: schema }, true, hbs)
				}
			}

			/* Support */
			for (const file of await fs.readdir(path.resolve(__dirname, '..', 'templates', 'support'))) {
				const fileBase = path.basename(file, path.extname(file))
				await emit(`support/${fileBase}`, path.join(outputPath, relativeSourceOutputPath, 'Support', fileBase),
					{ ...rootContext }, true, hbs)
			}

			/* Security */
			for (const file of await fs.readdir(path.resolve(__dirname, '..', 'templates', 'security'))) {
				const fileBase = path.basename(file, path.extname(file))
				await emit(`security/${fileBase}`, path.join(outputPath, relativeSourceOutputPath, 'Security', fileBase),
					{ ...rootContext, securitySchemes: doc.securitySchemes }, true, hbs)
			}

			await emit('Package', path.join(outputPath, 'Package.swift'),
				{ ...rootContext }, true, hbs)
	
			if (context.additionalExportTemplates) {
				await context.additionalExportTemplates(outputPath, doc, hbs, rootContext)
			}
		},

		postProcessDocument: (doc) => {
			if (!generatorOptions.package.name) {
				generatorOptions.package.name = context.generator().toClassName(doc.info.title)
			}
		},

		postProcessSchema(schema, helper) {
			function suggestedNameForType(type: CodegenNativeType): string {
				if (type.componentType) {
					return `${type.componentType.nativeType}_array`
				} else {
					return type.nativeType
				}
			}
			if (isCodegenOneOfSchema(schema)) {
				/* oneOf schemas turn into an enum, so each member needs a `name` for our enum */
				for (const comp of schema.composes) {
					if (comp.name === null) {
						comp.name = helper.uniqueName(suggestedNameForType(comp.nativeType), helper.scopeOf(schema), comp.schemaType, comp.purpose)
					}
				}
			}
		},

		checkPropertyCompatibility: (parentProp, childProp) => {
			if (!baseGenerator.checkPropertyCompatibility(parentProp, childProp)) {
				return false
			}

			/* Because in Swift we use `Nullable` if a property is nullable, properties are not compatible
			   if their nullability varies.
			 */
			if (!parentProp.nullable !== !childProp.nullable) {
				return false
			}

			/* Because in Swift we use a protocol for allOf, we can't comply if the required status mismatches at all,
			   for the same reason as nullability above.
			 */
			if (parentProp.required !== childProp.required) {
				return false
			}
			return true
		},
	}
}
