import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Config as FullReloadConfig } from 'vite-plugin-full-reload'
import { defaultDiscoverCommand, defaultDiscoverTimeout, validateInputs, type DiscoveredInputs } from './discover.js'

/** The framework's default manifest path, used when the application reports none. */
export const defaultManifest = '.vite/manifest.json'

/** An entry point, a list of them or a map of names to entry points, as Vite's `build.rollupOptions.input` takes it. */
export type InputOption = string | string[] | Record<string, string>

export type DevServerUrl = `${'http' | 'https'}://${string}:${number}`

export interface RefreshConfig {
    paths: string[]
    config?: FullReloadConfig
}

export interface PluginConfig {
    /** Entry points to build, relative to the project root. Added to the discovered ones; required when discovery is off. */
    input?: InputOption

    /**
     * Ask the application for its paths (`config/vite.go`) and the entries and
     * assets its views reference. A build builds those along with `input` and
     * `assets`; the dev server only takes the paths.
     *
     * @default true
     */
    discover?: boolean

    /**
     * The command that prints the discovered inputs as JSON, run in the project root. A string is split on whitespace.
     *
     * @default ['go', 'run', '.', 'artisan', 'vite:inputs']
     */
    discoverCommand?: string | string[]

    /**
     * How long to wait for the discovery command, in milliseconds. `go run` compiles the
     * application first, which takes a while on a cold cache.
     *
     * @default 300000
     */
    discoverTimeout?: number

    /** The output of `artisan vite:inputs`, for builds that cannot run the application. When given, the command is not run. */
    discovered?: DiscoveredInputs

    /**
     * The web root. Overrides what the application reports.
     *
     * @default what the application reports, or 'public'
     */
    publicDirectory?: string

    /**
     * The build directory inside the public directory. Overrides `vite.build_directory`.
     *
     * @default what the application reports, or 'build'
     */
    buildDirectory?: string

    /**
     * The file the dev server announces its URL in, relative to the project root (Vite's `root`). Overrides `vite.hot_file`.
     *
     * @default what the application reports, or `${publicDirectory}/hot`
     */
    hotFile?: string

    /**
     * Reload the page when a file outside the module graph changes. `true` watches
     * the view, language and route directories that exist.
     *
     * {@link https://github.com/ElMassimo/vite-plugin-full-reload}
     * @default false
     */
    refresh?: boolean | string | string[] | RefreshConfig | RefreshConfig[]

    /**
     * Globs of files to build and version although nothing imports them, e.g.
     * images used with `viteAsset`. Relative to the project root.
     *
     * @default []
     */
    assets?: string | string[]

    /** Transform the code the dev server serves, after the placeholder origin is replaced with the dev server URL. */
    transformOnServe?: (code: string, url: DevServerUrl) => string
}

export interface ResolvedPluginConfig {
    input: InputOption | undefined
    discover: boolean
    discoverCommand: string[]
    discoverTimeout: number
    discovered: DiscoveredInputs | null
    /** As the options set them; undefined where the application decides. The hot file is resolved against the root by `resolvePaths`. */
    publicDirectory: string | undefined
    buildDirectory: string | undefined
    hotFile: string | undefined
    refresh: boolean | string | string[] | RefreshConfig | RefreshConfig[]
    assets: string[]
    transformOnServe: (code: string, url: DevServerUrl) => string
}

/** The paths of this run, once the application has been asked. */
export interface ResolvedPaths {
    publicDirectory: string
    buildDirectory: string
    /** Absolute. */
    hotFile: string
    /** Relative to the build directory. */
    manifest: string
}

/** What `refresh: true` watches, leaving out directories that do not exist. */
export function defaultRefreshPaths(root: string): string[] {
    return ['lang/**', 'resources/lang/**', 'resources/views/**', 'routes/**'].filter((pattern) =>
        existsSync(path.resolve(root, pattern.replace(/\*\*$/, ''))),
    )
}

/** @param cwd - The working directory, which the refresh paths are relative to; the other paths wait for Vite's root. */
export function resolvePluginConfig(config: string | string[] | PluginConfig | undefined, cwd: string): ResolvedPluginConfig {
    if (typeof config === 'undefined') {
        throw new Error('goravel-vite-plugin: missing configuration.')
    }

    if (typeof config === 'string' || Array.isArray(config)) {
        config = { input: config }
    }

    const discover = config.discover ?? true

    if (typeof config.input === 'undefined' && !discover) {
        throw new Error('goravel-vite-plugin: missing configuration for "input", and discovery is off.')
    }

    const discoverCommand =
        typeof config.discoverCommand === 'string' ? config.discoverCommand.trim().split(/\s+/) : (config.discoverCommand ?? defaultDiscoverCommand)

    if (discoverCommand.length === 0 || discoverCommand[0] === '') {
        throw new Error('goravel-vite-plugin: discoverCommand must name a command.')
    }

    const discoverTimeout = config.discoverTimeout ?? defaultDiscoverTimeout

    if (!Number.isFinite(discoverTimeout) || discoverTimeout <= 0) {
        throw new Error('goravel-vite-plugin: discoverTimeout must be a number of milliseconds greater than zero.')
    }

    return {
        input: config.input,
        discover,
        discoverCommand,
        discoverTimeout,
        discovered: config.discovered ? validateInputs(config.discovered) : null,
        publicDirectory: subdirectory(config.publicDirectory, 'publicDirectory'),
        buildDirectory: subdirectory(config.buildDirectory, 'buildDirectory'),
        hotFile: config.hotFile,
        refresh: config.refresh === true ? [{ paths: defaultRefreshPaths(cwd) }] : (config.refresh ?? false),
        assets: typeof config.assets === 'string' ? [config.assets] : (config.assets ?? []),
        transformOnServe: config.transformOnServe ?? ((code) => code),
    }
}

/**
 * The paths of this run: an option wins, then what the application reported, then the framework's defaults.
 *
 * @param root - Vite's resolved root, which the project-relative paths are resolved against.
 */
export function resolvePaths(config: ResolvedPluginConfig, discovered: DiscoveredInputs | null, root: string): ResolvedPaths {
    const reported = discovered?.paths
    const publicDirectory = config.publicDirectory ?? (reported ? subdirectory(reported.public_directory, 'public_directory') : undefined) ?? 'public'
    const buildDirectory = config.buildDirectory ?? (reported ? subdirectory(reported.build_directory, 'build_directory') : undefined) ?? 'build'

    return {
        publicDirectory,
        buildDirectory,
        hotFile: path.resolve(root, config.hotFile ?? reported?.hot_file ?? path.join(publicDirectory, 'hot')),
        manifest: reported?.manifest ?? defaultManifest,
    }
}

/** Trims a directory and refuses one that would mean the project root itself. */
function subdirectory(value: string | undefined, option: string): string | undefined {
    if (typeof value !== 'string') {
        return undefined
    }

    const trimmed = value.trim().replace(/^\/+/, '').replace(/\/+$/, '')

    if (trimmed === '') {
        throw new Error(`goravel-vite-plugin: ${option} must be a subdirectory, not the project root.`)
    }

    return trimmed
}
