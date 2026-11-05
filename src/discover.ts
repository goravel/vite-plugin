import { spawnSync } from 'node:child_process'

/**
 * The output of `artisan vite:inputs`: the entries and assets the views reference
 * and where the framework reads the build and the hot file.
 */
export interface DiscoveredInputs {
    inputs: string[]
    assets: string[]
    /** Calls whose arguments are computed at render time. */
    dynamic?: { template: string; function: string }[]
    /** The paths of config/vite.go; absent from a framework that does not report them. */
    paths?: DiscoveredPaths
}

/** The paths as `config/vite.go` sets them. */
export interface DiscoveredPaths {
    /** The web root, relative to the project root. */
    public_directory: string
    /** The build directory inside the public directory. */
    build_directory: string
    /** Relative to the project root, or absolute. */
    hot_file: string
    /** Relative to the build directory. */
    manifest: string
}

/** Artisan through `go run`. */
export const defaultDiscoverCommand: string[] = ['go', 'run', '.', 'artisan', 'vite:inputs']

/** Five minutes: enough for `go run` to download the modules and compile the application. */
export const defaultDiscoverTimeout = 300_000

/** Runs the command in the project root and parses the JSON object on its last line. */
export function discoverInputs(command: string[], root: string, timeout: number = defaultDiscoverTimeout): DiscoveredInputs {
    const [executable, ...args] = command
    const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8', env: process.env, timeout })

    if (result.error && 'code' in result.error && result.error.code === 'ETIMEDOUT') {
        throw new Error(
            `goravel-vite-plugin: "${command.join(' ')}" did not finish within ${timeout / 1000}s. ` +
                "Raise the 'discoverTimeout' option if the application takes longer to start. " +
                explainAlternatives(),
        )
    }

    if (result.error) {
        throw new Error(
            `goravel-vite-plugin: could not run "${command.join(' ')}" to discover the entry points: ${result.error.message}. ` +
                explainAlternatives(),
        )
    }

    if (result.status !== 0) {
        throw new Error(
            `goravel-vite-plugin: "${command.join(' ')}" failed with exit code ${result.status}:\n${(result.stderr + result.stdout).trim()}\n` +
                explainAlternatives(),
        )
    }

    // Artisan colours piped output too; strip the codes before looking for the JSON.
    const line = stripAnsi(result.stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('{'))
        .at(-1)

    if (line === undefined) {
        throw new Error(
            `goravel-vite-plugin: "${command.join(' ')}" printed no JSON object:\n${result.stdout.trim()}\n` + explainAlternatives(),
        )
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(line)
    } catch (error) {
        throw new Error(
            `goravel-vite-plugin: "${command.join(' ')}" printed a line that is not JSON (${(error as Error).message}):\n${line}\n` +
                explainAlternatives(),
        )
    }

    return validateInputs(parsed)
}

/** Checks the shape of the command's output or of the `discovered` option. */
export function validateInputs(value: unknown): DiscoveredInputs {
    const { inputs, assets, dynamic, paths } = (value ?? {}) as Partial<DiscoveredInputs>

    if (
        !isStringList(inputs) ||
        !isStringList(assets) ||
        (dynamic !== undefined &&
            (!Array.isArray(dynamic) ||
                dynamic.some((call) => typeof call?.template !== 'string' || typeof call?.function !== 'string'))) ||
        (paths !== undefined && !isPaths(paths))
    ) {
        throw new Error(
            'goravel-vite-plugin: discovered inputs must look like { inputs: string[], assets: string[], dynamic?: { template: string, function: string }[], paths?: { public_directory: string, build_directory: string, hot_file: string, manifest: string } }, got ' +
                JSON.stringify(value),
        )
    }

    return {
        inputs,
        assets,
        ...(dynamic === undefined ? {} : { dynamic }),
        ...(paths === undefined ? {} : { paths }),
    }
}

function isPaths(value: unknown): value is DiscoveredPaths {
    const paths = value as Partial<DiscoveredPaths> | null

    return (
        typeof paths === 'object' &&
        paths !== null &&
        (['public_directory', 'build_directory', 'hot_file', 'manifest'] as const).every((key) => typeof paths[key] === 'string' && paths[key] !== '')
    )
}

// eslint-disable-next-line no-control-regex
const ansiPattern = /\x1b\[[0-9;]*[A-Za-z]/g

function stripAnsi(text: string): string {
    return text.replace(ansiPattern, '')
}

function isStringList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function explainAlternatives(): string {
    return "Set the 'discoverCommand' option to the command that runs Artisan, pass its output through the 'discovered' option, or set 'discover: false' and list the 'input' yourself."
}
