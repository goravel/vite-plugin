import fs from 'node:fs'
import path from 'node:path'
import colors from 'picocolors'
import { globSync } from 'tinyglobby'
import { createLogger, loadEnv, version as viteVersion, type ConfigEnv, type Plugin, type ResolvedConfig, type UserConfig } from 'vite'
import fullReload from 'vite-plugin-full-reload'
import {
    refreshPaths,
    resolvePaths,
    resolvePluginConfig,
    type DevServerUrl,
    type InputOption,
    type PluginConfig,
    type RefreshConfig,
    type ResolvedPaths,
    type ResolvedPluginConfig,
} from './config.js'
import { discoverInputs, type DiscoveredInputs } from './discover.js'
import {
    devServerIndex,
    ensureCommandShouldRunInEnvironment,
    goravelVersion,
    placeholderOrigin,
    pluginVersion,
    resolveDevServerUrl,
    resolveEnvironmentServerConfig,
} from './server.js'

export type { DevServerUrl, InputOption, PluginConfig, RefreshConfig, ResolvedPaths, ResolvedPluginConfig } from './config.js'
export type { DiscoveredInputs, DiscoveredPaths } from './discover.js'

interface GoravelPlugin extends Plugin {
    config: (config: UserConfig, env: ConfigEnv) => UserConfig
}

/** The directories `refresh: true` watches (those that exist); extend them with `refresh: [...refreshPaths, 'app/**']`. */
export { refreshPaths }

const logger = createLogger('info', { prefix: '[goravel-vite-plugin]' })

let exitHandlersBound = false

/**
 * Goravel plugin for Vite.
 *
 *     plugins: [goravel({ refresh: true })]
 *
 * Builds into the directory the framework's `vite` template function reads, with
 * the manifest it resolves entries through, and writes the dev server URL to the
 * hot file so the same function points at the dev server while it runs. Unless
 * `discover` is false, the paths and the entries the views reference come from
 * the application, so `config/vite.go` is the only place they are set.
 *
 * Paths are relative to Vite's `root`, which is the project root unless the
 * configuration moves it.
 *
 * @param config - A configuration object, or the entry point(s) to build.
 */
export function goravel(config: string | string[] | PluginConfig = {}): [GoravelPlugin, ...Plugin[]] {
    const pluginConfig = resolvePluginConfig(config, process.cwd())
    const assets = new Set(pluginConfig.assets)

    return [
        resolveGoravelPlugin(pluginConfig, assets),
        resolveAssetPlugin(assets),
        ...resolveFullReloadConfig(pluginConfig),
    ]
}

/** @param assets - The `assets` option; discovery adds to the set before the assets plugin reads it. */
function resolveGoravelPlugin(pluginConfig: ResolvedPluginConfig, assets: Set<string>): GoravelPlugin {
    let viteDevServerUrl: DevServerUrl
    let resolvedConfig: ResolvedConfig
    let userConfig: UserConfig
    let paths: ResolvedPaths

    const defaultAliases: Record<string, string> = {
        '@': '/resources/js',
    }

    return {
        name: 'goravel',
        enforce: 'post',
        config: (config, { command, mode }) => {
            userConfig = config
            // Vite resolves its own paths against this; so does the plugin, and the application runs here.
            const root = path.resolve(userConfig.root ?? process.cwd())
            const env = loadEnv(mode, path.resolve(root, typeof userConfig.envDir === 'string' ? userConfig.envDir : ''), '')
            const assetUrl = env.ASSET_URL ?? ''
            const serverConfig = command === 'serve' ? resolveEnvironmentServerConfig(env) : undefined

            ensureCommandShouldRunInEnvironment(command, env)

            // The application says where to build and which entries the views reference;
            // the dev server serves whatever the page asks for, so only a build needs the entries.
            const discovered = pluginConfig.discover ? (pluginConfig.discovered ?? runDiscovery(pluginConfig, root)) : null
            paths = resolvePaths(pluginConfig, discovered, root)
            // Absolute, so Rollup (Vite 7) finds the entries under a root that is not the working directory.
            const input = absoluteInput(command === 'build' ? resolveBuildInput(pluginConfig, discovered, assets) : (pluginConfig.input ?? []), root)

            return {
                base: userConfig.base ?? (command === 'build' ? resolveBase(paths, assetUrl) : ''),
                // Vite's own public directory would be copied into the build; Goravel serves public/ itself.
                publicDir: userConfig.publicDir ?? false,
                build: {
                    // Written where the framework reads it, whatever Vite's default.
                    manifest: userConfig.build?.manifest ?? paths.manifest,
                    outDir: userConfig.build?.outDir ?? path.join(paths.publicDirectory, paths.buildDirectory),
                    ...bundlerOptions(userConfig, input),
                    // Every asset gets a file and a manifest entry, so viteAsset can find it.
                    assetsInlineLimit: userConfig.build?.assetsInlineLimit ?? 0,
                },
                server: {
                    origin: userConfig.server?.origin ?? placeholderOrigin,
                    ...(serverConfig
                        ? {
                              host: userConfig.server?.host ?? serverConfig.host,
                              hmr:
                                  userConfig.server?.hmr === false
                                      ? false
                                      : {
                                            ...serverConfig.hmr,
                                            ...(typeof userConfig.server?.hmr === 'object' ? userConfig.server.hmr : {}),
                                        },
                              https: userConfig.server?.https ?? serverConfig.https,
                          }
                        : undefined),
                },
                resolve: {
                    alias: Array.isArray(userConfig.resolve?.alias)
                        ? [
                              ...(userConfig.resolve?.alias ?? []),
                              ...Object.keys(defaultAliases).map((alias) => ({
                                  find: alias,
                                  replacement: defaultAliases[alias],
                              })),
                          ]
                        : {
                              ...defaultAliases,
                              ...userConfig.resolve?.alias,
                          },
                },
            }
        },
        configResolved(config) {
            resolvedConfig = config
        },
        transform(code) {
            if (resolvedConfig.command === 'serve') {
                code = code.replaceAll(placeholderOrigin, viteDevServerUrl)

                return pluginConfig.transformOnServe(code, viteDevServerUrl)
            }
        },
        configureServer(server) {
            const envDir = resolvedConfig.envDir || resolvedConfig.root
            const appUrl = loadEnv(resolvedConfig.mode, envDir, 'APP_URL').APP_URL ?? 'undefined'

            server.httpServer?.once('listening', () => {
                const address = server.httpServer?.address()

                if (typeof address !== 'object' || address === null) {
                    return
                }

                viteDevServerUrl = userConfig.server?.origin
                    ? (userConfig.server.origin as DevServerUrl)
                    : resolveDevServerUrl(address, server.config)

                const hotFileParentDirectory = path.dirname(paths.hotFile)
                if (!fs.existsSync(hotFileParentDirectory)) {
                    fs.mkdirSync(hotFileParentDirectory, { recursive: true })
                    const created = fs.realpathSync(hotFileParentDirectory)
                    setTimeout(() => {
                        logger.info(`Hot file directory created ${colors.dim(created)}`, { clear: true, timestamp: true })
                    }, 200)
                }

                fs.writeFileSync(paths.hotFile, `${viteDevServerUrl}${server.config.base.replace(/\/$/, '')}`)

                setTimeout(() => {
                    server.config.logger.info(
                        `\n  ${colors.red(`${colors.bold('GORAVEL')} ${goravelVersion(server.config.root)}`)}  ${colors.dim('plugin')} ${colors.bold(`v${pluginVersion()}`)}`,
                    )
                    server.config.logger.info('')
                    server.config.logger.info(
                        `  ${colors.green('➜')}  ${colors.bold('APP_URL')}: ${colors.cyan(appUrl.replace(/:(\d+)/, (_, port) => `:${colors.bold(port)}`))}`,
                    )
                }, 100)
            })

            if (!exitHandlersBound) {
                const clean = () => {
                    if (fs.existsSync(paths.hotFile)) {
                        fs.rmSync(paths.hotFile)
                    }
                }

                process.on('exit', clean)
                process.on('SIGINT', () => process.exit())
                process.on('SIGTERM', () => process.exit())
                process.on('SIGHUP', () => process.exit())

                exitHandlersBound = true
            }

            return () =>
                server.middlewares.use((req, res, next) => {
                    if (req.url === '/index.html') {
                        res.statusCode = 404
                        res.end(devServerIndex(appUrl))

                        return
                    }

                    next()
                })
        },
    }
}

/** The build entries: `input` plus the discovered ones. Discovered assets go into the set. */
function resolveBuildInput(pluginConfig: ResolvedPluginConfig, discovered: DiscoveredInputs | null, assets: Set<string>): InputOption {
    if (discovered === null) {
        return pluginConfig.input ?? []
    }

    for (const asset of discovered.assets) {
        assets.add(asset)
    }

    for (const call of discovered.dynamic ?? []) {
        logger.warn(
            `${call.function} is called with a computed argument in ${call.template}; add that entry to 'input' yourself.`,
            { timestamp: true },
        )
    }

    const input = mergeInput(pluginConfig.input, discovered.inputs)

    if (Array.isArray(input) ? input.length === 0 : typeof input === 'object' && Object.keys(input).length === 0) {
        throw new Error(
            'goravel-vite-plugin: nothing to build. No view calls {{ vite ... }} with a constant entry point and no "input" is configured.',
        )
    }

    return input
}

function runDiscovery(pluginConfig: ResolvedPluginConfig, root: string): DiscoveredInputs {
    logger.info(`Asking the application for its paths and entry points with "${pluginConfig.discoverCommand.join(' ')}"`, { timestamp: true })

    return discoverInputs(pluginConfig.discoverCommand, root, pluginConfig.discoverTimeout)
}

/** Adds the discovered entries to `input` without changing its shape or repeating an entry. */
function mergeInput(input: InputOption | undefined, discovered: string[]): InputOption {
    if (input === undefined) {
        return discovered
    }

    if (typeof input === 'string') {
        return [input, ...discovered.filter((entry) => entry !== input)]
    }

    if (Array.isArray(input)) {
        return [...input, ...discovered.filter((entry) => !input.includes(entry))]
    }

    // The name only shapes the hashed file name; the path cannot clash with another entry or a user's name.
    const named = { ...input }
    const known = new Set(Object.values(input))
    for (const entry of discovered) {
        if (!known.has(entry)) {
            named[entry] = entry
        }
    }

    return named
}

/** The entries resolved against the root. Keys and manifest entries stay as they are; only the lookup changes. */
function absoluteInput(input: InputOption, root: string): InputOption {
    if (typeof input === 'string') {
        return path.resolve(root, input)
    }

    if (Array.isArray(input)) {
        return input.map((entry) => path.resolve(root, entry))
    }

    return Object.fromEntries(Object.entries(input).map(([name, entry]) => [name, path.resolve(root, entry)]))
}

/** The entries under the key the installed Vite expects: `rolldownOptions` from Vite 8, `rollupOptions` before. */
function bundlerOptions(userConfig: UserConfig, input: InputOption): Pick<NonNullable<UserConfig['build']>, 'rollupOptions' | 'rolldownOptions'> {
    const userInput = userConfig.build?.rolldownOptions?.input ?? userConfig.build?.rollupOptions?.input ?? input

    return parseInt(viteVersion) >= 8 ? { rolldownOptions: { input: userInput } } : { rollupOptions: { input: userInput } }
}

/** The public URL of the build directory, under ASSET_URL when one is set. */
function resolveBase(paths: ResolvedPaths, assetUrl: string): string {
    return assetUrl + (!assetUrl.endsWith('/') ? '/' : '') + paths.buildDirectory + '/'
}

/** Emits the `assets` option and the discovered assets into the build, so they are versioned and in the manifest. */
function resolveAssetPlugin(assets: Set<string>): Plugin {
    let root: string

    return {
        name: 'goravel:assets',
        apply: 'build',
        configResolved(config) {
            root = config.root
        },
        buildStart() {
            if (assets.size === 0) {
                return
            }

            // Globs are relative to the root, and so are the manifest keys.
            for (const file of globSync([...assets], { cwd: root })) {
                const absolute = path.join(root, file)

                if (fs.statSync(absolute).isFile()) {
                    this.emitFile({
                        type: 'asset',
                        name: path.basename(file),
                        originalFileName: file,
                        source: fs.readFileSync(absolute),
                    })
                }
            }
        },
    }
}

/** One full-reload plugin per refresh configuration. */
function resolveFullReloadConfig({ refresh: config }: ResolvedPluginConfig): Plugin[] {
    if (typeof config === 'boolean') {
        return []
    }

    if (typeof config === 'string') {
        config = [{ paths: [config] }]
    }

    if (!Array.isArray(config)) {
        config = [config]
    }

    if (config.some((c) => typeof c === 'string')) {
        config = [{ paths: config as string[] }]
    }

    return (config as RefreshConfig[]).flatMap((c) => {
        const plugin = fullReload(c.paths, c.config) as Plugin

        // Kept for inspection, so a wrapping plugin or a test can see what is watched.
        ;(plugin as Plugin & { __goravel_plugin_config?: RefreshConfig }).__goravel_plugin_config = c

        return plugin
    })
}

export default goravel
