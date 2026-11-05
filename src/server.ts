import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import type { ResolvedConfig } from 'vite'
import type { DevServerUrl } from './config.js'

/** The origin the dev server uses until its address is known; `transform` rewrites served code to the real URL. */
export const placeholderOrigin = 'http://__goravel_vite_placeholder__.test'

/** The dev server URL as the browser reaches it, honouring an explicit host or HMR config. */
export function resolveDevServerUrl(address: AddressInfo, config: ResolvedConfig): DevServerUrl {
    const configHmrProtocol = typeof config.server.hmr === 'object' ? config.server.hmr.protocol : null
    const clientProtocol = configHmrProtocol ? (configHmrProtocol === 'wss' ? 'https' : 'http') : null
    const serverProtocol = config.server.https ? 'https' : 'http'
    const protocol = clientProtocol ?? serverProtocol

    const configHmrHost = typeof config.server.hmr === 'object' ? config.server.hmr.host : null
    const configHost = typeof config.server.host === 'string' ? config.server.host : null
    const serverAddress = isIpv6(address) ? `[${address.address}]` : address.address
    const host = configHmrHost ?? configHost ?? serverAddress

    const configHmrClientPort = typeof config.server.hmr === 'object' ? config.server.hmr.clientPort : null
    const port = configHmrClientPort ?? address.port

    return `${protocol}://${host}:${port}`
}

function isIpv6(address: AddressInfo): boolean {
    return address.family === 'IPv6' || (address.family as unknown as number) === 6
}

/** TLS for the dev server from VITE_DEV_SERVER_KEY and VITE_DEV_SERVER_CERT, as laravel-vite-plugin reads them. */
export interface EnvironmentServerConfig {
    hmr: { host: string }
    host: string
    https: { key: Buffer; cert: Buffer }
}

/** @param root - What relative certificate paths are resolved against. */
export function resolveEnvironmentServerConfig(env: Record<string, string>, root: string): EnvironmentServerConfig | undefined {
    if (!env.VITE_DEV_SERVER_KEY && !env.VITE_DEV_SERVER_CERT) {
        return
    }

    const key = path.resolve(root, env.VITE_DEV_SERVER_KEY ?? '')
    const cert = path.resolve(root, env.VITE_DEV_SERVER_CERT ?? '')

    if (!env.VITE_DEV_SERVER_KEY || !env.VITE_DEV_SERVER_CERT || !fs.existsSync(key) || !fs.existsSync(cert)) {
        throw Error(
            `Unable to find the certificate files specified in your environment. Ensure you have correctly configured VITE_DEV_SERVER_KEY: [${env.VITE_DEV_SERVER_KEY}] and VITE_DEV_SERVER_CERT: [${env.VITE_DEV_SERVER_CERT}].`,
        )
    }

    const host = resolveHostFromEnv(env)

    if (!host) {
        throw Error(`Unable to determine the host from the environment's APP_URL: [${env.APP_URL}].`)
    }

    return {
        hmr: { host },
        host,
        https: {
            key: fs.readFileSync(key),
            cert: fs.readFileSync(cert),
        },
    }
}

function resolveHostFromEnv(env: Record<string, string>): string | undefined {
    try {
        return new URL(env.APP_URL).host
    } catch {
        return
    }
}

/** Refuses to start the HMR server in CI unless GORAVEL_BYPASS_ENV_CHECK=1. */
export function ensureCommandShouldRunInEnvironment(command: 'build' | 'serve', env: Record<string, string>): void {
    if (command === 'build' || env.GORAVEL_BYPASS_ENV_CHECK === '1') {
        return
    }

    if (typeof env.CI !== 'undefined') {
        throw Error(
            'You should not run the Vite HMR server in CI environments. You should build your assets for production instead. To disable this ENV check you may set GORAVEL_BYPASS_ENV_CHECK=1',
        )
    }
}

/** The framework version from go.mod, for the dev server banner. */
export function goravelVersion(root: string): string {
    try {
        const match = /^\s*github\.com\/goravel\/framework\s+(\S+)/m.exec(fs.readFileSync(path.join(root, 'go.mod'), 'utf8'))

        return match?.[1] ?? ''
    } catch {
        return ''
    }
}

export function pluginVersion(): string {
    try {
        const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }

        return packageJson.version ?? ''
    } catch {
        return ''
    }
}

/** The page shown when the dev server is opened in a browser by mistake. */
export function devServerIndex(appUrl: string): string {
    const href = escapeHtml(appUrl)

    return `<!DOCTYPE html>
<html lang="en">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Goravel Vite</title>
        <style>
            body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f3f4f6; color: #4b5563; font: 16px/1.5 system-ui, sans-serif; }
            main { background: #fff; padding: 2.5rem; border-radius: .5rem; box-shadow: 0 10px 25px rgb(0 0 0 / .08); max-width: 36rem; }
            h1 { margin: 0 0 1rem; font-size: 1.25rem; color: #111827; }
            a { color: #dc2626; }
            @media (prefers-color-scheme: dark) { body { background: #111827; color: #9ca3af; } main { background: #1f2937; } h1 { color: #f3f4f6; } }
        </style>
    </head>
    <body>
        <main>
            <h1>This is the Vite dev server.</h1>
            <p>It only serves your assets. Open your Goravel application instead: <a href="${href}">${href}</a>.</p>
        </main>
    </body>
</html>
`
}

function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
