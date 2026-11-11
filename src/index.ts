import fs from 'node:fs'
import path from 'node:path'
import colors from 'picocolors'
import { globSync } from 'tinyglobby'
import { createLogger, loadEnv, version as viteVersion, type ConfigEnv, type Plugin, type ResolvedConfig, type UserConfig } from 'vite'
import fullReload from 'vite-plugin-full-reload'
import { aliasesKey, collectAliases, resolveEntry } from './aliases.js'
import {
    defaultManifest,
    moduleRefreshPaths,
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
import { discoverInputs, type DiscoveredInputs, type DiscoveredModule } from './discover.js'
import {
    configuredOrigin,
    devServerIndex,
    ensureCommandShouldRunInEnvironment,
    goravelVersion,
    placeholderOrigin,
    pluginVersion,
    resolveDevServerUrl,
    resolveEnvironmentServerConfig,
} from './server.js'

export type { DevServerUrl, InputOption, PluginConfig, RefreshConfig, ResolvedPaths, ResolvedPluginConfig } from './config.js'
export type { DiscoveredInputs, DiscoveredModule, DiscoveredPaths } from './discover.js'
export { collectAliases, resolveAlias, resolveEntry } from './aliases.js'

interface GoravelPlugin extends Plugin {
    config: (config: UserConfig, env: ConfigEnv) => UserConfig
}

/** The directories `refresh: true` watches (those that exist); extend them with `refresh: [...refreshPaths, 'app/**']`. */
export { refreshPaths }

const logger = createLogger('info', { prefix: '[goravel-vite-plugin]' })

/** The hot files of the dev servers running in this process, and what each wrote, removed when the process exits. */
const hotFiles = new Map<string, string>()
let exitHandlersBound = false

/** Writes the hot file, creating its directory; a failure is reported rather than thrown, since the server is already listening. */
function claimHotFile(hotFile: string, content: string, viteLogger: ResolvedConfig['logger']): boolean {
    try {
        const directory = path.dirname(hotFile)
        const created = !fs.existsSync(directory)
        fs.mkdirSync(directory, { recursive: true })
        fs.writeFileSync(hotFile, content)

        if (created) {
            const realpath = fs.realpathSync(directory)
            setTimeout(() => {
                logger.info(`Hot file directory created ${colors.dim(realpath)}`, { clear: true, timestamp: true })
            }, 200)
        }
    } catch (error) {
        viteLogger.error(
            colors.red(
                `goravel-vite-plugin: could not write the hot file at '${hotFile}': ${(error as Error).message}. ` +
                    'The application reads it to find the dev server, and renders the build until it can. Set vite.hot_file to a path it can write.',
            ),
        )

        return false
    }

    hotFiles.set(hotFile, content)

    return true
}

/** Removes the hot file, unless another server has since written its own URL into it. */
function releaseHotFile(hotFile: string, content: string): void {
    if (hotFiles.get(hotFile) === content) {
        hotFiles.delete(hotFile)
    }

    try {
        if (fs.readFileSync(hotFile, 'utf8') === content) {
            fs.rmSync(hotFile)
        }
    } catch {
        // Already gone, or never written.
    }
}

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
    let resolvedConfig: ResolvedConfig
    let userConfig: UserConfig
    let paths: ResolvedPaths
    // The @ aliases that point inside the project, handed to the application through the manifest and the hot file.
    let aliases: Record<string, string> = {}

    // The URL the browser reaches the dev server at, known once it listens (or from
    // server.origin); undefined where there is no server of its own to listen.
    let devServerUrl: Promise<DevServerUrl | undefined>
    let setDevServerUrl: (url: DevServerUrl | undefined) => void
    const awaitDevServerUrl = (): void => {
        devServerUrl = new Promise((resolve) => {
            setDevServerUrl = resolve
        })
    }
    awaitDevServerUrl()
    let warnedUnknownUrl = false
    // A server.origin of the user's own, once validated.
    let origin: DevServerUrl | undefined

    return {
        name: 'goravel',
        enforce: 'post',
        config: (config, { command, mode }) => {
            userConfig = config
            // Vite resolves its own paths against this; so does the plugin, and the application runs here.
            const root = path.resolve(userConfig.root ?? process.cwd())
            // Vite's envDir, relative to the root; false leaves only the process environment, as it does for Vite.
            const env = loadEnv(mode, userConfig.envDir === false ? false : path.resolve(root, userConfig.envDir ?? ''), '')
            const assetUrl = env.ASSET_URL ?? ''
            const serverConfig = command === 'serve' ? resolveEnvironmentServerConfig(env, root) : undefined

            ensureCommandShouldRunInEnvironment(command, env)

            // The application says where to build and which entries the views reference;
            // the dev server serves whatever the page asks for, so only a build needs the entries.
            const discovered = pluginConfig.discover ? (pluginConfig.discovered ?? runDiscovery(pluginConfig, root)) : null
            paths = resolvePaths(pluginConfig, discovered, root)
            // Entries the user named in the Vite config are built as written; the plugin's are then ignored.
            const userNamedTheEntries = userInputKey(userConfig) !== undefined
            if (command === 'build' && userNamedTheEntries) {
                logger.warn(
                    `${userInputKey(userConfig)} is set in your Vite config, so it is built as written and the plugin's 'input' is ignored, ` +
                        'along with the entries discovered from the views. Name the entries in one place or the other.',
                    { timestamp: true },
                )
            }
            const modules = discovered?.modules ?? []
            // full-reload reads its paths when the server starts, after this hook; explicit refresh values are left alone.
            const refreshed = pluginConfig.defaultRefresh?.paths
            refreshed?.push(...moduleRefreshPaths(root, modules).filter((pattern) => !refreshed.includes(pattern)))
            // The user's aliases come first, so theirs wins over the plugin's of the same name.
            const defaultAliases = pluginAliases(root, modules)
            const alias = Array.isArray(userConfig.resolve?.alias)
                ? [...userConfig.resolve.alias, ...Object.entries(defaultAliases).map(([find, replacement]) => ({ find, replacement }))]
                : { ...defaultAliases, ...userConfig.resolve?.alias }
            aliases = collectAliases(root, alias)
            // Absolute, so Rollup (Vite 7) finds the entries under a root that is not the working directory.
            const input = absoluteInput(
                command === 'build' ? resolveBuildInput(pluginConfig, discovered, assets, userNamedTheEntries, aliases) : (pluginConfig.input ?? []),
                root,
            )

            return {
                base: userConfig.base ?? (command === 'build' ? resolveBase(userBuildDirectory(userConfig, paths, root) ?? paths.buildDirectory, assetUrl) : ''),
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
                    // Fonts and modules are fetched in CORS mode from wherever the application is served; Vite admits only localhost by default.
                    cors: userConfig.server?.cors ?? true,
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
                resolve: { alias },
            }
        },
        configResolved(config) {
            resolvedConfig = config

            if (config.command === 'build') {
                warnAboutTheManifest(config, paths)
            }

            // An origin of the user's own is the URL from the start, before (or without) a server listening.
            origin = configuredOrigin(config)
            if (origin) {
                setDevServerUrl(origin)
            }
        },
        async transform(code) {
            if (resolvedConfig.command !== 'serve') {
                return
            }

            // Vite warms files up before the server listens; those wait here rather than keep the placeholder.
            const url = await devServerUrl

            if (url === undefined) {
                // No server of its own (middleware mode), so no origin to put in: the URLs stay relative to the page.
                if (!code.includes(placeholderOrigin)) {
                    return
                }

                if (!warnedUnknownUrl) {
                    warnedUnknownUrl = true
                    resolvedConfig.logger.warn(
                        colors.yellow(
                            'goravel-vite-plugin: the dev server URL is unknown, so asset URLs are left relative to the page that loads them. ' +
                                "Set 'server.origin' to the URL Vite is reachable at.",
                        ),
                    )
                }

                return code.replaceAll(placeholderOrigin, '')
            }

            return pluginConfig.transformOnServe(code.replaceAll(placeholderOrigin, url), url)
        },
        writeBundle() {
            const { build, root } = resolvedConfig

            if (build.manifest === false || build.ssr) {
                return
            }

            // Vite has written its manifest by now; the alias table joins it under a key no chunk can have.
            const file = path.resolve(root, build.outDir, build.manifest === true ? defaultManifest : build.manifest)

            if (fs.existsSync(file)) {
                const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
                fs.writeFileSync(file, JSON.stringify({ ...manifest, [aliasesKey]: aliases }, null, 2))
            }
        },
        configureServer(server) {
            const appUrl = loadEnv(resolvedConfig.mode, resolvedConfig.envDir, 'APP_URL').APP_URL ?? 'undefined'

            // A restarted server binds anew, unless the origin was configured.
            if (!origin) {
                awaitDevServerUrl()
            }

            if (!server.httpServer) {
                setDevServerUrl(origin)
            }

            server.httpServer?.once('listening', () => {
                const address = server.httpServer?.address()

                if (typeof address !== 'object' || address === null) {
                    setDevServerUrl(origin)

                    return
                }

                const viteDevServerUrl = origin ?? resolveDevServerUrl(address, server.config)
                setDevServerUrl(viteDevServerUrl)

                // One line of JSON: the URL, and the aliases the application resolves in {{ vite "@/app.js" }}.
                const hotFileContent = JSON.stringify({ url: `${viteDevServerUrl}${server.config.base.replace(/\/$/, '')}`, aliases })
                claimHotFile(paths.hotFile, hotFileContent, server.config.logger)

                // A closed server no longer serves anything, so its hot file goes with it.
                server.httpServer?.once('close', () => releaseHotFile(paths.hotFile, hotFileContent))

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

            // Bound once for the process; every running server's hot file is in the map.
            if (!exitHandlersBound) {
                process.on('exit', () => {
                    for (const [hotFile, content] of [...hotFiles]) {
                        releaseHotFile(hotFile, content)
                    }
                })
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

/**
 * Warns when Vite writes its manifest under a name the application does not read. The
 * directory is the build directory's concern, warned about where the base is derived.
 */
function warnAboutTheManifest(config: ResolvedConfig, paths: ResolvedPaths): void {
    const readFrom = path.join(config.root, config.build.outDir, paths.manifest)

    if (config.build.manifest === false) {
        logger.warn(
            `build.manifest is false, so Vite writes no manifest, and the application resolves every asset it renders through one: it expects to read "${readFrom}".`,
            { timestamp: true },
        )

        return
    }

    const written = config.build.manifest === true ? defaultManifest : config.build.manifest

    if (path.normalize(written) !== path.normalize(paths.manifest)) {
        logger.warn(
            `Vite writes its manifest to "${path.join(config.root, config.build.outDir, written)}", but the application reads it from "${readFrom}" ` +
                'and will report the build as missing. Drop build.manifest from your Vite config, or set vite.manifest in config/vite.go to the file Vite writes.',
            { timestamp: true },
        )
    }
}

/** The key under which the user named the entries in the Vite config, if they did. */
function userInputKey(userConfig: UserConfig): 'build.rolldownOptions.input' | 'build.rollupOptions.input' | undefined {
    if (userConfig.build?.rolldownOptions?.input !== undefined) {
        return 'build.rolldownOptions.input'
    }

    return userConfig.build?.rollupOptions?.input !== undefined ? 'build.rollupOptions.input' : undefined
}

/**
 * The build entries: `input` plus the discovered ones. Discovered assets go into the set.
 *
 * @param userNamedTheEntries - The user's own entries are built instead, so having none here is no error.
 */
function resolveBuildInput(
    pluginConfig: ResolvedPluginConfig,
    discovered: DiscoveredInputs | null,
    assets: Set<string>,
    userNamedTheEntries: boolean,
    aliases: Record<string, string>,
): InputOption {
    if (discovered === null) {
        return pluginConfig.input ?? []
    }

    // Views may name an entry through an alias or with "./" and "..": the manifest keys are the plain paths.
    for (const asset of discovered.assets) {
        assets.add(resolveEntry(asset, aliases))
    }

    for (const call of discovered.dynamic ?? []) {
        logger.warn(
            `${call.function} is called with a computed argument in ${call.template}; add that entry to 'input' yourself.`,
            { timestamp: true },
        )
    }

    // Module entries are built whether or not a view references them.
    const entries = [...discovered.inputs, ...(discovered.modules ?? []).flatMap((module) => module.entries)]
    const input = mergeInput(pluginConfig.input, [...new Set(entries.map((entry) => resolveEntry(entry, aliases)))])

    if (!userNamedTheEntries && (Array.isArray(input) ? input.length === 0 : typeof input === 'object' && Object.keys(input).length === 0)) {
        throw new Error(
            'goravel-vite-plugin: nothing to build. No view calls {{ vite ... }} with a constant entry point and no "input" is configured.',
        )
    }

    return input
}

/**
 * The plugin's aliases: `@` for the application, `@<name>` for each module with a
 * `resources/js` directory, then those the modules declare, which may replace their own `@<name>`.
 */
function pluginAliases(root: string, modules: DiscoveredModule[]): Record<string, string> {
    const aliases: Record<string, string> = { '@': '/resources/js' }

    for (const module of modules) {
        if (fs.existsSync(path.join(root, module.path, 'resources/js'))) {
            aliases[`@${module.name}`] = path.posix.join('/', module.path, 'resources/js')
        }
    }

    for (const module of modules) {
        for (const [name, directory] of Object.entries(module.aliases ?? {})) {
            aliases[name] = path.posix.join('/', directory)
        }
    }

    return aliases
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
function resolveBase(buildDirectory: string, assetUrl: string): string {
    return assetUrl + (!assetUrl.endsWith('/') ? '/' : '') + buildDirectory + '/'
}

/**
 * Where a `build.outDir` of the user's own sits inside the public directory, so the
 * URLs in the build match the files; undefined when it is outside. Either way the
 * application reads only `vite.build_directory`, so a different directory is warned about.
 */
function userBuildDirectory(userConfig: UserConfig, paths: ResolvedPaths, root: string): string | undefined {
    const outDir = userConfig.build?.outDir

    if (!outDir) {
        return undefined
    }

    const relative = path.relative(path.resolve(root, paths.publicDirectory), path.resolve(root, outDir))
    const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
    const buildDirectory = inside ? relative.split(path.sep).join('/') : undefined

    if (buildDirectory !== paths.buildDirectory) {
        logger.warn(
            `build.outDir "${outDir}" is not the application's build directory "${path.join(paths.publicDirectory, paths.buildDirectory)}", ` +
                `where it reads the manifest from. Set vite.build_directory in config/vite.go instead.`,
            { timestamp: true },
        )
    }

    return buildDirectory
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
