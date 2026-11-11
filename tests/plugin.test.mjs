import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { build, createServer, resolveConfig } from 'vite'
import goravel, { collectAliases, refreshPaths, resolveAlias, resolveEntry } from '../dist/index.js'
import { configuredOrigin, resolveDevServerUrl } from '../dist/server.js'

const appInput = ['resources/css/app.css', 'resources/js/app.js']

// The plugin reads the real environment as well as .env files, so a CI runner's own
// CI variable would stop every dev-server test. The suite sets what it needs in .env.
delete process.env.CI
delete process.env.GORAVEL_BYPASS_ENV_CHECK

const roots = []
const cwd = process.cwd()

afterEach(() => {
    process.chdir(cwd)

    for (const root of roots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true })
    }
})

/**
 * A project root with a resources directory holding the two entries. The plugin
 * resolves its options against the working directory, like Vite does, so the
 * test moves there.
 */
function project(files = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goravel-vite-'))
    roots.push(root)

    write(root, {
        'resources/js/app.js': "import '../css/greet.css'\nimport { greet } from '@/greet.js'\nexport const message = greet('vite')\n",
        'resources/js/greet.js': 'export const greet = (name) => `hello ${name}`\n',
        'resources/css/greet.css': 'h1 { color: green; }\n',
        'resources/css/app.css': 'body { color: red; }\n',
        ...files,
    })

    process.chdir(root)

    return fs.realpathSync(root)
}

/** A Vite logger that says nothing; a test replaces the method it listens to. */
const silentLogger = {
    info() {},
    warn() {},
    warnOnce() {},
    error() {},
    clearScreen() {},
    hasErrorLogged: () => false,
    hasWarned: false,
}

function write(root, files) {
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
        fs.writeFileSync(path.join(root, file), content)
    }
}

/** The dev server URL in the hot file, which is one line of JSON. */
function hotUrl(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8')).url
}

function resolve(root, plugins, inlineConfig = {}, command = 'build') {
    return resolveConfig({ configFile: false, logLevel: 'silent', root, plugins, ...inlineConfig }, command)
}

/** The paths handed to the full-reload plugins, which only act on the dev server. */
function refreshedPaths(plugins) {
    return plugins.flat(Infinity).flatMap((plugin) => plugin.__goravel_plugin_config?.paths ?? [])
}

/** The entry points of the resolved build, under whichever key this Vite uses, relative to the root again. */
function inputOf(config) {
    const input = (config.build.rolldownOptions ?? config.build.rollupOptions).input
    const relative = (entry) => path.relative(config.root, entry).split(path.sep).join('/')

    if (typeof input === 'string') {
        return relative(input)
    }

    return Array.isArray(input) ? input.map(relative) : Object.fromEntries(Object.entries(input).map(([name, entry]) => [name, relative(entry)]))
}

test('builds into public/build with a manifest the framework reads', async () => {
    const root = project()
    const config = await resolve(root, goravel({ input: appInput, discover: false }))

    assert.ok(config.plugins.some((plugin) => plugin.name === 'goravel'))
    assert.equal(config.base, '/build/')
    assert.equal(config.publicDir, '')
    assert.equal(config.build.manifest, '.vite/manifest.json')
    assert.equal(config.build.outDir, path.join('public', 'build'))
    assert.equal(config.build.assetsInlineLimit, 0)
    assert.deepEqual(inputOf(config), appInput)
})

test('accepts an entry, a list of entries or a full configuration', async () => {
    const root = project()

    const single = await resolve(root, goravel({ input: 'resources/js/app.js', discover: false }))
    assert.deepEqual(inputOf(single), 'resources/js/app.js')

    const list = await resolve(root, goravel({ input: appInput, discover: false }))
    assert.deepEqual(inputOf(list), appInput)

    const named = await resolve(root, goravel({ input: { app: 'resources/js/app.js' }, discover: false }))
    assert.deepEqual(inputOf(named), { app: 'resources/js/app.js' })
})

test('the directories can be moved', async () => {
    const root = project()
    const config = await resolve(root, goravel({ input: appInput, publicDirectory: 'www/', buildDirectory: '/assets/', discover: false }))

    assert.equal(config.base, '/assets/')
    assert.equal(config.build.outDir, path.join('www', 'assets'))
})

test('ASSET_URL prefixes the base in a build', async () => {
    const root = project({ '.env': 'ASSET_URL=https://cdn.example.com\n' })

    const built = await resolve(root, goravel({ input: appInput, discover: false }))
    assert.equal(built.base, 'https://cdn.example.com/build/')

    const served = await resolve(root, goravel({ input: appInput, discover: false }), {}, 'serve')
    assert.equal(served.base, '/')
})

test("a build.outDir of the user's own moves the URLs with it", async () => {
    const root = project({ '.env': 'ASSET_URL=https://cdn.example.com\n' })

    const inside = await resolve(root, goravel({ input: appInput, discover: false }), { build: { outDir: 'public/dist/v2' } })
    assert.equal(inside.base, 'https://cdn.example.com/dist/v2/')

    const absolute = await resolve(root, goravel({ input: appInput, discover: false, publicDirectory: 'www' }), { build: { outDir: path.join(root, 'www/assets') } })
    assert.equal(absolute.base, 'https://cdn.example.com/assets/')

    // Outside the public directory nothing can serve it; the URLs fall back to the build directory.
    const outside = await resolve(root, goravel({ input: appInput, discover: false }), { build: { outDir: 'dist' } })
    assert.equal(outside.base, 'https://cdn.example.com/build/')
    const itself = await resolve(root, goravel({ input: appInput, discover: false }), { build: { outDir: 'public' } })
    assert.equal(itself.base, 'https://cdn.example.com/build/')

    // The application's own directory, spelled out, is no reason to warn.
    const same = await resolve(root, goravel({ input: appInput, discover: false }), { build: { outDir: './public/build/' } })
    assert.equal(same.base, 'https://cdn.example.com/build/')
})

test("the user's own configuration wins", async () => {
    const root = project()
    const config = await resolve(root, goravel({ input: appInput, discover: false }), {
        base: '/other/',
        publicDir: 'static',
        build: { manifest: 'assets.json', outDir: 'dist', rolldownOptions: { input: 'resources/js/other.js' } },
        server: { origin: 'http://example.test:5173' },
    })

    assert.equal(config.base, '/other/')
    assert.equal(config.publicDir, path.join(root, 'static'))
    assert.equal(config.build.manifest, 'assets.json')
    assert.equal(config.build.outDir, 'dist')
    assert.deepEqual(inputOf(config), 'resources/js/other.js')
    assert.equal(config.server.origin, 'http://example.test:5173')
})

/** Runs the body with the plugin's own warnings collected, which it prints through console.warn. */
async function warningsOf(body) {
    const warnings = []
    const warn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))

    try {
        await body()
    } finally {
        console.warn = warn
    }

    return warnings
}

test('a manifest the application does not read is warned about', async () => {
    const root = project()
    const plugins = () => goravel({ input: appInput, discover: false })

    const none = await warningsOf(() => resolve(root, plugins(), { build: { manifest: false } }))
    assert.equal(none.length, 1)
    assert.match(none[0], /build\.manifest is false/)
    assert.match(none[0], /public[\\/]build[\\/]\.vite[\\/]manifest\.json/)

    const elsewhere = await warningsOf(() => resolve(root, plugins(), { build: { manifest: 'assets.json' } }))
    assert.equal(elsewhere.length, 1)
    assert.match(elsewhere[0], /writes its manifest to ".*assets\.json"/)
    assert.match(elsewhere[0], /vite\.manifest/)

    // The application's own name, spelled out, and the dev server, are no reason to warn.
    assert.deepEqual(await warningsOf(() => resolve(root, plugins(), { build: { manifest: '.vite/manifest.json' } })), [])
    assert.deepEqual(await warningsOf(() => resolve(root, plugins(), { build: { manifest: true } })), [])
    assert.deepEqual(await warningsOf(() => resolve(root, plugins())), [])
    assert.deepEqual(await warningsOf(() => resolve(root, plugins(), { build: { manifest: false } }, 'serve')), [])
})

test("entries named in the Vite config are built as written, and said to be", async () => {
    const root = project({ 'resources/js/other.js': 'export const other = 1\n' })
    const key = (config) => Object.keys(config.build).find((option) => option === 'rolldownOptions' || option === 'rollupOptions')

    let config
    const warnings = await warningsOf(async () => {
        config = await resolve(root, goravel({ input: appInput, discover: false }), { build: { [key(await resolve(root, []))]: { input: 'resources/js/other.js' } } })
    })
    assert.deepEqual(inputOf(config), 'resources/js/other.js')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /build\.(rolldown|rollup)Options\.input is set/)
    assert.match(warnings[0], /discovered from the views/)

    // Nor is there anything to complain about when the views name nothing: the user's entries are the build.
    const discovered = { inputs: [], assets: [], paths: { public_directory: 'public', build_directory: 'build', hot_file: 'public/hot', manifest: '.vite/manifest.json' } }
    const named = await resolve(root, goravel({ discovered }), { build: { [key(config)]: { input: 'resources/js/other.js' } } })
    assert.deepEqual(inputOf(named), 'resources/js/other.js')

    // The dev server builds nothing, so it says nothing.
    assert.deepEqual(await warningsOf(() => resolve(root, goravel({ input: appInput, discover: false }), { build: { [key(config)]: { input: 'resources/js/other.js' } } }, 'serve')), [])
})

test('aliases @ to resources/js unless the user says otherwise', async () => {
    const root = project()

    const config = await resolve(root, goravel({ input: appInput, discover: false }))
    assert.deepEqual(
        config.resolve.alias.filter(({ find }) => find === '@').map(({ replacement }) => replacement),
        ['/resources/js'],
    )

    const own = await resolve(root, goravel({ input: appInput, discover: false }), { resolve: { alias: { '@': '/src' } } })
    assert.deepEqual(
        own.resolve.alias.filter(({ find }) => find === '@').map(({ replacement }) => replacement),
        ['/src'],
    )

    // Aliases resolve top-down, so the first match is what counts.
    const list = await resolve(root, goravel({ input: appInput, discover: false }), {
        resolve: { alias: [{ find: '~', replacement: '/lib' }, { find: '@', replacement: '/src' }] },
    })
    assert.equal(list.resolve.alias.find(({ find }) => find === '~').replacement, '/lib')
    assert.equal(list.resolve.alias.find(({ find }) => find === '@').replacement, '/src')

    const listWithout = await resolve(root, goravel({ input: appInput, discover: false }), { resolve: { alias: [{ find: '~', replacement: '/lib' }] } })
    assert.equal(listWithout.resolve.alias.find(({ find }) => find === '@').replacement, '/resources/js')
})

test('a real build writes the files and the manifest where the framework looks', async () => {
    const root = project({ 'resources/images/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' })

    await build({
        configFile: false,
        logLevel: 'silent',
        root,
        plugins: goravel({ input: appInput, assets: 'resources/images/**', discover: false }),
    })

    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/build/.vite/manifest.json'), 'utf8'))

    const js = manifest['resources/js/app.js']
    assert.ok(js.isEntry)
    assert.match(js.file, /^assets\/app-[\w-]+\.js$/)
    assert.ok(fs.existsSync(path.join(root, 'public/build', js.file)))
    assert.equal(js.css.length, 1)

    const css = manifest['resources/css/app.css']
    assert.ok(css.isEntry)
    assert.match(css.file, /^assets\/app-[\w-]+\.css$/)
    // The stylesheet app.js imports is its own file, not the app.css entry.
    assert.notEqual(js.css[0], css.file)
    assert.ok(fs.existsSync(path.join(root, 'public/build', js.css[0])))

    // Files of the assets option are built although nothing imports them.
    const logo = manifest['resources/images/logo.svg']
    assert.match(logo.file, /^assets\/logo-[\w-]+\.svg$/)
    assert.ok(fs.existsSync(path.join(root, 'public/build', logo.file)))

    // Nothing of public/ itself is copied around, and no hot file is left behind.
    assert.equal(fs.existsSync(path.join(root, 'public/hot')), false)
})

test('the dev server announces itself in the hot file', async () => {
    const root = project({ '.env': 'APP_URL=http://localhost:3000\n', 'resources/images/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' })

    const server = await createServer({
        configFile: false,
        logLevel: 'silent',
        root,
        server: { host: '127.0.0.1', port: 0 },
        plugins: goravel({ input: appInput, discover: false }),
    })

    try {
        await server.listen()

        const { port } = server.httpServer.address()
        const hotFile = path.join(root, 'public', 'hot')

        assert.ok(fs.existsSync(hotFile))
        assert.equal(hotUrl(hotFile), `http://127.0.0.1:${port}`)

        // Served code refers to the dev server, not the placeholder origin Vite was configured with.
        const result = await server.transformRequest('/resources/images/logo.svg?import')
        assert.match(result.code, new RegExp(`http://127\\.0\\.0\\.1:${port}/resources/images/logo.svg`))
        assert.doesNotMatch(result.code, /__goravel_vite_placeholder__/)

        // Opening the dev server itself explains where the application is.
        const response = await fetch(`http://127.0.0.1:${port}/index.html`)
        assert.equal(response.status, 404)
        assert.match(await response.text(), /href="http:\/\/localhost:3000"/)
    } finally {
        await server.close()
    }
})

test('the dev server answers every origin', async () => {
    // Fonts and module scripts are CORS requests, and Vite admits only localhost by default.
    const root = project()

    const serve = (server = {}) =>
        createServer({
            configFile: false,
            logLevel: 'silent',
            root,
            server: { host: '127.0.0.1', port: 0, ...server },
            plugins: goravel({ input: appInput, discover: false }),
        })

    const allowed = async (server, origin) => {
        const { port } = server.httpServer.address()
        const response = await fetch(`http://127.0.0.1:${port}/resources/css/app.css`, { headers: { origin, accept: 'text/css' } })
        assert.equal(response.status, 200)

        return response.headers.get('access-control-allow-origin')
    }

    const server = await serve()
    try {
        await server.listen()

        assert.equal(await allowed(server, 'http://goravel.test:3000'), '*')
        assert.equal(await allowed(server, 'http://192.168.1.5:8000'), '*')
    } finally {
        await server.close()
    }

    // A cors setting of the user's own is taken as given.
    const own = await serve({ cors: { origin: ['http://elsewhere.test'] } })
    try {
        await own.listen()

        assert.equal(await allowed(own, 'http://elsewhere.test'), 'http://elsewhere.test')
        assert.equal(await allowed(own, 'http://goravel.test:3000'), null)
    } finally {
        await own.close()
    }
})

test('the dev server index page ends the response', async () => {
    const root = project({ '.env': 'APP_URL=http://localhost:3000\n' })
    const reached = []

    // A middleware behind the plugin's: it must not run for a response the plugin ended.
    const after = {
        name: 'after',
        enforce: 'post',
        configureServer: (server) => () =>
            server.middlewares.use((req, _res, next) => {
                reached.push(req.url)
                next()
            }),
    }

    const server = await createServer({
        configFile: false,
        logLevel: 'silent',
        root,
        server: { host: '127.0.0.1', port: 0 },
        plugins: [goravel({ input: appInput, discover: false }), after],
    })

    try {
        await server.listen()

        const { port } = server.httpServer.address()

        const index = await fetch(`http://127.0.0.1:${port}/index.html`)
        assert.equal(index.status, 404)
        assert.match(await index.text(), /href="http:\/\/localhost:3000"/)

        // Not asking for HTML, so Vite's fallback does not rewrite the URL to /index.html.
        const other = await fetch(`http://127.0.0.1:${port}/not-served.txt`, { headers: { accept: 'application/json' } })
        assert.equal(other.status, 404)

        assert.deepEqual(reached, ['/not-served.txt'])
    } finally {
        await server.close()
    }
})

/** A resolved config as the URL resolver reads it, with a logger that records warnings. */
function serverConfig(server = {}) {
    const warnings = []

    return {
        warnings,
        config: {
            server: { host: false, hmr: true, https: undefined, origin: undefined, ...server },
            logger: { warn: (message) => warnings.push(message) },
        },
    }
}

const bound = (address, port = 5173, family = address.includes(':') ? 'IPv6' : 'IPv4') => ({ address, port, family })

test('the dev server URL names the bound address, except where a browser cannot use it', () => {
    const url = (address, server) => resolveDevServerUrl(address, serverConfig(server).config)

    assert.equal(url(bound('127.0.0.1')), 'http://127.0.0.1:5173')
    assert.equal(url(bound('192.168.1.5')), 'http://192.168.1.5:5173')
    assert.equal(url(bound('fe80::1')), 'http://[fe80::1]:5173')
    assert.equal(url({ address: 'fe80::1', port: 5173, family: 6 }), 'http://[fe80::1]:5173', 'old node reported the family as a number')

    // A wildcard or IPv6 loopback bind is not an address a browser can reach.
    assert.equal(url(bound('0.0.0.0')), 'http://localhost:5173')
    assert.equal(url(bound('::')), 'http://localhost:5173')
    assert.equal(url(bound('::1')), 'http://localhost:5173')

    // A host the config names wins, bracketed when it is IPv6 and skipped when it is a wildcard.
    assert.equal(url(bound('0.0.0.0'), { host: '192.168.1.5' }), 'http://192.168.1.5:5173')
    assert.equal(url(bound('0.0.0.0'), { hmr: { host: 'dev.example.test' } }), 'http://dev.example.test:5173')
    assert.equal(url(bound('0.0.0.0'), { host: 'ignored.test', hmr: { host: 'dev.example.test' } }), 'http://dev.example.test:5173')
    assert.equal(url(bound('0.0.0.0'), { hmr: { host: 'fe80::1' } }), 'http://[fe80::1]:5173')
    assert.equal(url(bound('0.0.0.0'), { hmr: { host: '[fe80::1]' } }), 'http://[fe80::1]:5173')
    assert.equal(url(bound('0.0.0.0'), { host: '0.0.0.0' }), 'http://localhost:5173')
    assert.equal(url(bound('::'), { hmr: { host: '::' }, host: 'dev.example.test' }), 'http://dev.example.test:5173')
    assert.equal(url(bound('0.0.0.0'), { host: '' }), 'http://localhost:5173')

    // Protocol and port follow the HMR config, as the browser connects.
    assert.equal(url(bound('127.0.0.1'), { https: {} }), 'https://127.0.0.1:5173')
    assert.equal(url(bound('127.0.0.1'), { hmr: { protocol: 'wss', clientPort: 443, host: 'assets.test' } }), 'https://assets.test:443')
})

test('exposing the dev server to the network warns that the hot file says localhost', () => {
    const { config, warnings } = serverConfig({ host: true })
    resolveDevServerUrl(bound('0.0.0.0'), config)

    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /bound to '0\.0\.0\.0'/)
    assert.match(warnings[0], /server\.hmr\.host/)
    assert.match(warnings[0], /server\.allowedHosts/)

    // A named host silences it, and so does a bind that is not a wildcard.
    const named = serverConfig({ host: true, hmr: { host: '192.168.1.5' } })
    resolveDevServerUrl(bound('0.0.0.0'), named.config)
    assert.deepEqual(named.warnings, [])

    const loopback = serverConfig()
    resolveDevServerUrl(bound('127.0.0.1'), loopback.config)
    assert.deepEqual(loopback.warnings, [])
})

test('a server.origin of the user\'s own is trimmed, and refused unless it is an http(s) URL', () => {
    const origin = (value) => {
        const { config, warnings } = serverConfig({ origin: value })

        return [configuredOrigin(config), warnings]
    }

    assert.deepEqual(origin(undefined), [undefined, []])
    assert.deepEqual(origin('http://__goravel_vite_placeholder__.test'), [undefined, []], 'the placeholder is not an origin anyone configured')
    assert.deepEqual(origin('https://assets.example.test'), ['https://assets.example.test', []])
    assert.deepEqual(origin('http://localhost:5173/'), ['http://localhost:5173', []])
    assert.deepEqual(origin('http://localhost:5173/vite/'), ['http://localhost:5173/vite', []], 'a path survives, as Vite treats it')

    const [refused, warnings] = origin('localhost:5173')
    assert.equal(refused, undefined)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /'server\.origin' is 'localhost:5173'/)
    assert.deepEqual(origin('ws://localhost:5173')[0], undefined)
})

test('a wildcard bind writes localhost to the hot file, and a configured origin writes itself', async () => {
    const root = project({ 'resources/images/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' })

    const serve = (server) =>
        createServer({
            configFile: false,
            logLevel: 'silent',
            root,
            server: { port: 0, ...server },
            plugins: goravel({ input: appInput, discover: false }),
        })

    const wildcard = await serve({ host: '0.0.0.0' })
    try {
        await wildcard.listen()
        const { port } = wildcard.httpServer.address()

        assert.equal(hotUrl(path.join(root, 'public', 'hot')), `http://localhost:${port}`)

        const result = await wildcard.transformRequest('/resources/images/logo.svg?import')
        assert.match(result.code, new RegExp(`http://localhost:${port}/resources/images/logo.svg`))
    } finally {
        await wildcard.close()
    }

    // The trailing slash stays out of the hot file; the application appends the paths itself.
    const origin = await serve({ host: '127.0.0.1', origin: 'http://assets.test:5173/' })
    try {
        await origin.listen()
        assert.equal(hotUrl(path.join(root, 'public', 'hot')), 'http://assets.test:5173')
    } finally {
        await origin.close()
    }

    // An origin that is not a URL is ignored in favour of the bound address.
    const refused = await serve({ host: '127.0.0.1', origin: 'assets.test:5173' })
    try {
        await refused.listen()
        const { port } = refused.httpServer.address()
        assert.equal(hotUrl(path.join(root, 'public', 'hot')), `http://127.0.0.1:${port}`)
    } finally {
        await refused.close()
    }
})

test('a transform that starts before the server listens waits for its URL', async () => {
    // Vite warms files up before the server is listening; the placeholder must not be left in them.
    const root = project({ 'resources/images/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' })

    const server = await createServer({
        configFile: false,
        logLevel: 'silent',
        root,
        server: { host: '127.0.0.1', port: 0 },
        plugins: goravel({ input: appInput, discover: false }),
    })

    try {
        const pending = server.transformRequest('/resources/images/logo.svg?import')
        let settled = false
        pending.then(() => (settled = true))
        await new Promise((resolve) => setTimeout(resolve, 200))
        assert.equal(settled, false, 'it cannot answer before the URL is known')

        await server.listen()
        const { port } = server.httpServer.address()
        const result = await pending
        assert.match(result.code, new RegExp(`http://127\\.0\\.0\\.1:${port}/resources/images/logo.svg`))
        assert.doesNotMatch(result.code, /__goravel_vite_placeholder__/)
    } finally {
        await server.close()
    }
})

test('a hot file of your own and transformOnServe', async () => {
    const root = project()
    const seen = []

    const server = await createServer({
        configFile: false,
        logLevel: 'silent',
        root,
        server: { host: '127.0.0.1', port: 0 },
        plugins: goravel({
            input: appInput,
            discover: false,
            hotFile: 'storage/vite.hot',
            transformOnServe: (code, url) => {
                seen.push(url)
                return code.replace('hello', 'hi')
            },
        }),
    })

    try {
        await server.listen()

        const { port } = server.httpServer.address()
        assert.equal(hotUrl(path.join(root, 'storage', 'vite.hot')), `http://127.0.0.1:${port}`)

        const result = await server.transformRequest('/resources/js/greet.js')
        assert.match(result.code, /hi \$\{name\}/)
        assert.deepEqual([...new Set(seen)], [`http://127.0.0.1:${port}`])
    } finally {
        await server.close()
    }
})

test('in middleware mode the URL comes from server.origin, or stays unknown', async () => {
    const root = project({ 'resources/images/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' })
    const seen = []

    const serve = (server, logger) =>
        createServer({
            configFile: false,
            ...(logger ? { customLogger: { ...silentLogger, ...logger } } : { logLevel: 'silent' }),
            root,
            server: { middlewareMode: true, ...server },
            plugins: goravel({
                input: appInput,
                discover: false,
                transformOnServe: (code, url) => {
                    seen.push(url)
                    return code
                },
            }),
        })

    // Vite has no server of its own, so the plugin cannot know a URL; the asset URLs stay relative to the page, and it says so.
    const warnings = []
    const unknown = await serve({}, { warn: (message) => warnings.push(message) })
    try {
        const result = await unknown.transformRequest('/resources/images/logo.svg?import')
        assert.match(result.code, /"\/resources\/images\/logo\.svg(\?import)?"/)
        assert.doesNotMatch(result.code, /__goravel_vite_placeholder__/)
        assert.doesNotMatch(result.code, /undefined/)
        assert.deepEqual(seen, [])
        assert.equal(warnings.filter((message) => message.includes('dev server URL is unknown')).length, 1)
    } finally {
        await unknown.close()
    }

    const origin = await serve({ origin: 'http://assets.test:5173' })
    try {
        const result = await origin.transformRequest('/resources/images/logo.svg?import')
        assert.match(result.code, /http:\/\/assets\.test:5173\/resources\/images\/logo\.svg/)
        assert.deepEqual([...new Set(seen)], ['http://assets.test:5173'])
    } finally {
        await origin.close()
    }
})

test('each dev server removes its own hot file when it closes', async () => {
    const root = project()

    const serve = (hotFile) =>
        createServer({
            configFile: false,
            logLevel: 'silent',
            root,
            server: { host: '127.0.0.1', port: 0 },
            plugins: goravel({ input: appInput, discover: false, hotFile }),
        })

    const first = await serve('storage/first.hot')
    const second = await serve('storage/second.hot')

    try {
        await first.listen()
        await second.listen()
        assert.ok(fs.existsSync(path.join(root, 'storage/first.hot')))
        assert.ok(fs.existsSync(path.join(root, 'storage/second.hot')))

        await second.close()
        assert.equal(fs.existsSync(path.join(root, 'storage/second.hot')), false)
        assert.ok(fs.existsSync(path.join(root, 'storage/first.hot')))
    } finally {
        await first.close()
        await second.close()
    }

    assert.equal(fs.existsSync(path.join(root, 'storage/first.hot')), false)
})

test('a closing server leaves a hot file another server has since written', async () => {
    // Two dev servers for one project: the second took the hot file over, and the first must not delete it on its way out.
    const root = project()

    const serve = () =>
        createServer({
            configFile: false,
            logLevel: 'silent',
            root,
            server: { host: '127.0.0.1', port: 0 },
            plugins: goravel({ input: appInput, discover: false }),
        })

    const hotFile = path.join(root, 'public', 'hot')
    const first = await serve()
    const second = await serve()

    try {
        await first.listen()
        await second.listen()
        const secondUrl = `http://127.0.0.1:${second.httpServer.address().port}`
        assert.equal(hotUrl(hotFile), secondUrl)

        await first.close()
        assert.equal(hotUrl(hotFile), secondUrl, 'the first server does not own the hot file any more')

        await second.close()
        assert.equal(fs.existsSync(hotFile), false)
    } finally {
        await first.close()
        await second.close()
    }
})

test('a hot file that cannot be written is reported, not thrown', async () => {
    // A directory where the file should be: the server keeps serving, and the error says what to set.
    const root = project({ 'storage/hot/.keep': '' })
    const errors = []

    const server = await createServer({
        configFile: false,
        customLogger: { ...silentLogger, error: (message) => errors.push(message) },
        root,
        server: { host: '127.0.0.1', port: 0 },
        plugins: goravel({ input: appInput, discover: false, hotFile: 'storage/hot' }),
    })

    try {
        await server.listen()
        const { port } = server.httpServer.address()

        assert.equal(errors.length, 1)
        assert.match(errors[0], /could not write the hot file at '.*storage[\\/]hot'/)
        assert.match(errors[0], /vite\.hot_file/)

        // Still serving, and the served code still knows the URL.
        const result = await server.transformRequest('/resources/js/greet.js')
        assert.match(result.code, /hello/)
        assert.equal((await fetch(`http://127.0.0.1:${port}/resources/css/app.css`)).status, 200)
        assert.ok(fs.statSync(path.join(root, 'storage', 'hot')).isDirectory(), 'the directory is left alone')
    } finally {
        await server.close()
    }
})

test('refresh: true watches the view, language and route directories that exist', () => {
    const root = project()

    fs.mkdirSync(path.join(root, 'resources/views'), { recursive: true })
    fs.mkdirSync(path.join(root, 'routes'))

    assert.deepEqual(refreshedPaths(goravel({ input: appInput, refresh: true })), ['resources/views/**', 'routes/**'])
    assert.deepEqual(refreshedPaths(goravel({ input: appInput, discover: false })), [])
    assert.deepEqual(refreshedPaths(goravel({ input: appInput, refresh: false })), [])
})

test('other refresh values are watched as given', () => {
    project()

    assert.deepEqual(refreshedPaths(goravel({ input: appInput, refresh: 'app/**' })), ['app/**'])
    assert.deepEqual(refreshedPaths(goravel({ input: appInput, refresh: ['app/**', 'routes/**'] })), ['app/**', 'routes/**'])
    assert.deepEqual(
        refreshedPaths(goravel({ input: appInput, refresh: [{ paths: ['a/**'] }, { paths: ['b/**'], config: { delay: 300 } }] })),
        ['a/**', 'b/**'],
    )
    assert.deepEqual(refreshPaths, ['lang/**', 'resources/lang/**', 'resources/views/**', 'routes/**'])
    assert.deepEqual(refreshedPaths(goravel({ input: appInput, refresh: [...refreshPaths, 'app/**'] })), [...refreshPaths, 'app/**'])
})

test('refuses to start the dev server in CI unless told otherwise', async () => {
    const root = project({ '.env': 'CI=1\n' })

    await assert.rejects(() => resolve(root, goravel({ input: appInput, discover: false }), {}, 'serve'), /should not run the Vite HMR server in CI/)

    const bypassed = await resolve(root, goravel({ input: appInput, discover: false }), { envDir: writeEnv(root, 'CI=1\nGORAVEL_BYPASS_ENV_CHECK=1\n') }, 'serve')
    assert.equal(bypassed.command, 'serve')

    const built = await resolve(root, goravel({ input: appInput, discover: false }))
    assert.equal(built.command, 'build')
})

test('TLS certificates from the environment are relative to the root', async () => {
    const root = project({
        '.env': 'APP_URL=https://app.test\nVITE_DEV_SERVER_KEY=certs/key.pem\nVITE_DEV_SERVER_CERT=certs/cert.pem\n',
        'certs/key.pem': 'key',
        'certs/cert.pem': 'cert',
    })
    process.chdir(os.tmpdir())

    const config = await resolve(root, goravel({ input: appInput, discover: false }), {}, 'serve')

    assert.equal(config.server.host, 'app.test')
    assert.equal(config.server.https.key.toString(), 'key')
    assert.equal(config.server.https.cert.toString(), 'cert')

    await assert.rejects(
        () => resolve(root, goravel({ input: appInput, discover: false }), { envDir: writeEnv(root, 'VITE_DEV_SERVER_KEY=missing.pem\nVITE_DEV_SERVER_CERT=certs/cert.pem\n') }, 'serve'),
        /Unable to find the certificate files/,
    )
})

test('envDir: false leaves only the process environment', async () => {
    const root = project({ '.env': 'CI=1\nASSET_URL=https://cdn.example.com\n' })

    // The .env would stop the dev server and move the base; Vite is told not to read it, so neither happens.
    const served = await resolve(root, goravel({ input: appInput, discover: false }), { envDir: false }, 'serve')
    assert.equal(served.command, 'serve')

    const built = await resolve(root, goravel({ input: appInput, discover: false }), { envDir: false })
    assert.equal(built.base, '/build/')
})

function writeEnv(root, content) {
    const dir = path.join(root, 'env-' + Math.random().toString(36).slice(2))
    write(dir, { '.env': content })

    return dir
}

test('rejects malformed options', async () => {
    const { resolvePluginConfig } = await import('../dist/config.js')

    assert.throws(() => resolvePluginConfig(undefined, '/app'), /missing configuration/)
    assert.throws(() => resolvePluginConfig({ discover: false }, '/app'), /missing configuration for "input", and discovery is off/)
    assert.throws(() => resolvePluginConfig({ discoverCommand: ' ' }, '/app'), /discoverCommand must name a command/)
    assert.throws(() => resolvePluginConfig({ discoverTimeout: 0 }, '/app'), /discoverTimeout must be a number of milliseconds/)
    assert.equal(resolvePluginConfig({}, '/app').discoverTimeout, 300_000)
    assert.equal(resolvePluginConfig({ discoverTimeout: 1000 }, '/app').discoverTimeout, 1000)
    assert.throws(() => resolvePluginConfig({ discovered: { inputs: 'a.js' } }, '/app'), /discovered inputs must look like/)
    assert.deepEqual(resolvePluginConfig({}, '/app').discoverCommand, ['go', 'run', '.', 'artisan', 'vite:inputs'])
    assert.deepEqual(resolvePluginConfig({ discoverCommand: './main artisan vite:inputs' }, '/app').discoverCommand, ['./main', 'artisan', 'vite:inputs'])
    assert.equal(resolvePluginConfig({}, '/app').discover, true)
    assert.equal(resolvePluginConfig({}, '/app').discovered, null)
    assert.throws(() => resolvePluginConfig({ input: 'a.js', publicDirectory: ' / ' }, '/app'), /publicDirectory must be a subdirectory/)
    assert.throws(() => resolvePluginConfig({ input: 'a.js', buildDirectory: '' }, '/app'), /buildDirectory must be a subdirectory/)
    assert.throws(() => resolvePluginConfig({ discovered: { inputs: [], assets: [], paths: { public_directory: 'public' } } }, '/app'), /discovered inputs must look like/)

    const resolved = resolvePluginConfig({ input: 'a.js', assets: 'images/*' }, '/app')
    assert.equal(resolved.hotFile, undefined)
    assert.equal(resolvePluginConfig({ input: 'a.js', hotFile: 'storage/hot' }, '/app').hotFile, 'storage/hot')
    assert.equal(resolved.refresh, false)
    assert.deepEqual(resolved.assets, ['images/*'])
    assert.equal(resolved.transformOnServe('code', 'http://localhost:5173'), 'code')
})

/**
 * A stand-in for `go run . artisan vite:inputs`: a Node script that prints the
 * given JSON, and logs each call so a test can see whether it was asked.
 */
function fakeArtisan(root, output, { exitCode = 0, prefix = '', hang = false } = {}) {
    write(root, {
        'artisan.cjs':
            `require('node:fs').appendFileSync(${JSON.stringify(path.join(root, 'calls.log'))}, process.argv.slice(2).join(' ') + '\\n')\n` +
            (prefix ? `console.log(${JSON.stringify(prefix)})\n` : '') +
            (hang ? 'setInterval(() => {}, 1000)\n' : '') +
            `console.log(${JSON.stringify(typeof output === 'string' ? output : JSON.stringify(output))})\n` +
            (hang ? '' : `process.exit(${exitCode})\n`),
    })

    return [process.execPath, 'artisan.cjs', 'vite:inputs']
}

function calls(root) {
    return fs.existsSync(path.join(root, 'calls.log')) ? fs.readFileSync(path.join(root, 'calls.log'), 'utf8').trim().split('\n') : []
}

const discovered = { inputs: ['resources/css/app.css', 'resources/js/app.js'], assets: ['resources/images/logo.svg'], dynamic: [] }

/** What a framework configured through config/vite.go reports, with every directory moved. */
const moved = {
    ...discovered,
    paths: { public_directory: 'www', build_directory: 'assets', hot_file: 'storage/vite.hot', manifest: 'manifest.json' },
}

test('the paths come from the application', async () => {
    const { resolvePaths, resolvePluginConfig } = await import('../dist/config.js')

    // Nothing reported: the framework's defaults.
    assert.deepEqual(resolvePaths(resolvePluginConfig({}, '/app'), discovered, '/app'), {
        publicDirectory: 'public',
        buildDirectory: 'build',
        hotFile: path.resolve('/app', 'public', 'hot'),
        manifest: '.vite/manifest.json',
    })
    assert.deepEqual(resolvePaths(resolvePluginConfig({ input: 'a.js', discover: false }, '/app'), null, '/app'), {
        publicDirectory: 'public',
        buildDirectory: 'build',
        hotFile: path.resolve('/app', 'public', 'hot'),
        manifest: '.vite/manifest.json',
    })

    // Reported paths are taken as they are, the hot file resolved against the project root.
    assert.deepEqual(resolvePaths(resolvePluginConfig({}, '/app'), moved, '/app'), {
        publicDirectory: 'www',
        buildDirectory: 'assets',
        hotFile: path.resolve('/app', 'storage', 'vite.hot'),
        manifest: 'manifest.json',
    })
    const absolute = resolvePaths(resolvePluginConfig({}, '/app'), { ...moved, paths: { ...moved.paths, hot_file: '/tmp/hot' } }, '/app')
    assert.equal(absolute.hotFile, path.resolve('/tmp/hot'))
    assert.throws(
        () => resolvePaths(resolvePluginConfig({}, '/app'), { ...moved, paths: { ...moved.paths, build_directory: '/' } }, '/app'),
        /build_directory must be a subdirectory/,
    )

    // Options override what the application reports, each on its own.
    const options = resolvePluginConfig({ publicDirectory: 'static', hotFile: 'hot' }, '/app')
    assert.deepEqual(resolvePaths(options, moved, '/app'), {
        publicDirectory: 'static',
        buildDirectory: 'assets',
        hotFile: path.resolve('/app', 'hot'),
        manifest: 'manifest.json',
    })
})

test('paths, discovery and the environment follow the Vite root, not the working directory', async () => {
    const root = project({
        '.env': 'ASSET_URL=https://cdn.example.com\n',
        'resources/images/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    })
    const discoverCommand = fakeArtisan(root, moved)

    // Somewhere else entirely; only the configuration names the project.
    process.chdir(os.tmpdir())

    // The .env is read from the root.
    const config = await resolve(root, goravel({ discoverCommand }))
    assert.equal(config.base, 'https://cdn.example.com/assets/')

    await build({
        configFile: false,
        logLevel: 'silent',
        root,
        plugins: goravel({ discoverCommand }),
    })

    assert.deepEqual(calls(root), ['vite:inputs', 'vite:inputs'])
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'www/assets/manifest.json'), 'utf8'))
    assert.ok(manifest['resources/js/app.js'].isEntry)
    assert.match(manifest['resources/images/logo.svg'].file, /^assets\/logo-[\w-]+\.svg$/)

    const server = await createServer({
        configFile: false,
        logLevel: 'silent',
        root: path.relative(process.cwd(), root),
        server: { host: '127.0.0.1', port: 0 },
        plugins: goravel({ discoverCommand, hotFile: 'tmp/hot' }),
    })

    try {
        await server.listen()

        const { port } = server.httpServer.address()
        assert.equal(hotUrl(path.join(root, 'tmp', 'hot')), `http://127.0.0.1:${port}`)
        assert.equal(fs.existsSync(path.join(process.cwd(), 'tmp', 'hot')), false)
    } finally {
        await server.close()
    }
})

test('a build goes where the application reads it', async () => {
    const root = project()
    const discoverCommand = fakeArtisan(root, moved)

    const config = await resolve(root, goravel({ discoverCommand }))

    assert.equal(config.base, '/assets/')
    assert.equal(config.build.outDir, path.join('www', 'assets'))
    assert.equal(config.build.manifest, 'manifest.json')
    assert.deepEqual(inputOf(config), discovered.inputs)
})

test('the dev server announces itself where the application reads it', async () => {
    const root = project()
    const discoverCommand = fakeArtisan(root, moved)

    const server = await createServer({
        configFile: false,
        logLevel: 'silent',
        root,
        server: { host: '127.0.0.1', port: 0 },
        plugins: goravel({ discoverCommand }),
    })

    try {
        await server.listen()

        const { port } = server.httpServer.address()
        assert.equal(hotUrl(path.join(root, 'storage', 'vite.hot')), `http://127.0.0.1:${port}`)
        assert.equal(fs.existsSync(path.join(root, 'public', 'hot')), false)
    } finally {
        await server.close()
    }
})

test('a build discovers the entry points from the views', async () => {
    const root = project()
    const discoverCommand = fakeArtisan(root, discovered, { prefix: 'Booting the application...' })

    const config = await resolve(root, goravel({ discoverCommand }))

    assert.deepEqual(inputOf(config), discovered.inputs)
    assert.deepEqual(calls(root), ['vite:inputs'])
})

test('input and assets are added to what is discovered, without repeats', async () => {
    const root = project()
    const discoverCommand = fakeArtisan(root, discovered)

    const list = await resolve(root, goravel({ input: ['resources/js/app.js', 'resources/js/extra.js'], discoverCommand }))
    assert.deepEqual(inputOf(list), ['resources/js/app.js', 'resources/js/extra.js', 'resources/css/app.css'])

    const single = await resolve(root, goravel({ input: 'resources/js/extra.js', discoverCommand }))
    assert.deepEqual(inputOf(single), ['resources/js/extra.js', 'resources/css/app.css', 'resources/js/app.js'])

    // Discovered entries are named after their path, so app.js and app.ts cannot clash with each other or a user's name.
    const named = await resolve(root, goravel({ input: { app: 'resources/js/app.js', 'resources/js/admin': 'resources/js/admin.css' }, discoverCommand }))
    assert.deepEqual(inputOf(named), {
        app: 'resources/js/app.js',
        'resources/js/admin': 'resources/js/admin.css',
        'resources/css/app.css': 'resources/css/app.css',
    })
})

test('discovered assets are built along with the assets option', async () => {
    const root = project({
        'resources/images/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
        'resources/images/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>',
    })
    // Artisan colours the line it prints; the plugin reads through the codes.
    const discoverCommand = fakeArtisan(root, `\x1b[39m${JSON.stringify(discovered)}\x1b[0m`, { prefix: 'Booting...' })

    await build({
        configFile: false,
        logLevel: 'silent',
        root,
        plugins: goravel({ assets: 'resources/images/icon.svg', discoverCommand }),
    })

    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/build/.vite/manifest.json'), 'utf8'))
    assert.ok(manifest['resources/js/app.js'].isEntry)
    assert.ok(manifest['resources/css/app.css'].isEntry)
    assert.match(manifest['resources/images/logo.svg'].file, /^assets\/logo-[\w-]+\.svg$/)
    assert.match(manifest['resources/images/icon.svg'].file, /^assets\/icon-[\w-]+\.svg$/)
})

test('the dev server asks for the paths but builds nothing', async () => {
    const root = project()
    const discoverCommand = fakeArtisan(root, discovered)

    const config = await resolve(root, goravel({ discoverCommand }), {}, 'serve')

    assert.deepEqual(inputOf(config), [])
    assert.deepEqual(calls(root), ['vite:inputs'])
})

test('discover: false and the discovered option skip the command', async () => {
    const root = project()
    const discoverCommand = fakeArtisan(root, discovered)

    const off = await resolve(root, goravel({ input: appInput, discover: false, discoverCommand }))
    assert.deepEqual(inputOf(off), appInput)

    const given = await resolve(root, goravel({ input: 'resources/js/extra.js', discovered, discoverCommand }))
    assert.deepEqual(inputOf(given), ['resources/js/extra.js', ...discovered.inputs])

    assert.deepEqual(calls(root), [])
})

test('explains a failing or silent discovery command', async () => {
    const root = project()

    await assert.rejects(
        () => resolve(root, goravel({ discoverCommand: fakeArtisan(root, 'Command "vite:inputs" is not defined.', { exitCode: 1 }) })),
        (error) => /failed with exit code 1/.test(error.message) && /is not defined/.test(error.message) && /discover: false/.test(error.message),
    )

    await assert.rejects(
        () => resolve(root, goravel({ discoverCommand: fakeArtisan(root, 'no json here') })),
        /printed no JSON object/,
    )

    await assert.rejects(
        () => resolve(root, goravel({ discoverCommand: fakeArtisan(root, '{"inputs": [truncated') })),
        (error) => /printed a line that is not JSON/.test(error.message) && /\{"inputs": \[truncated/.test(error.message) && /discover: false/.test(error.message),
    )

    await assert.rejects(
        () => resolve(root, goravel({ discoverCommand: fakeArtisan(root, { inputs: 'nope' }) })),
        /discovered inputs must look like/,
    )

    await assert.rejects(
        () => resolve(root, goravel({ discoverCommand: fakeArtisan(root, { inputs: [], assets: [], paths: { manifest: 1 } }) })),
        /discovered inputs must look like/,
    )

    await assert.rejects(
        () => resolve(root, goravel({ discoverCommand: [path.join(root, 'does-not-exist')] })),
        /could not run/,
    )

    // A command that never exits is given up on, even after it printed the JSON.
    await assert.rejects(
        () => resolve(root, goravel({ discoverCommand: fakeArtisan(root, discovered, { hang: true }), discoverTimeout: 500 })),
        /did not finish within 0\.5s.*discoverTimeout/,
    )

    await assert.rejects(
        () => resolve(root, goravel({ discoverCommand: fakeArtisan(root, { inputs: [], assets: [] }) })),
        /nothing to build/,
    )
})

const blogFiles = {
    'modules/blog/resources/js/app.js': "import '../css/app.css'\nexport const blog = true\n",
    'modules/blog/resources/css/app.css': 'h2 { color: blue; }\n',
    'modules/blog/resources/assets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
}

test('collects the @ aliases that point inside the project', () => {
    const root = project({ ...blogFiles, 'resources/ui/button.js': '', 'node_modules/pkg/index.js': '' })

    assert.deepEqual(
        collectAliases(root, [
            { find: '@ui', replacement: path.join(root, 'resources/ui') },
            { find: '@', replacement: '/resources/js' },
            { find: '@blog', replacement: '/modules/blog/resources/js' },
            // Left out: a second alias of a taken name, a pattern, a package, a missing directory, a file, another kind of name.
            { find: '@', replacement: '/resources/ui' },
            { find: /^@re/, replacement: '/resources/js' },
            { find: '@pkg', replacement: '/node_modules/pkg' },
            { find: '@gone', replacement: '/resources/gone' },
            { find: '@file', replacement: '/resources/js/app.js' },
            { find: '@out', replacement: path.dirname(root) },
            { find: '@bare', replacement: 'resources/js' },
            { find: '~', replacement: '/resources/js' },
        ]),
        { '@ui': 'resources/ui', '@': 'resources/js', '@blog': 'modules/blog/resources/js' },
    )
    assert.deepEqual(collectAliases(root, { '@': '/resources/js', '~': '/resources/js' }), { '@': 'resources/js' })
    assert.deepEqual(collectAliases(root, undefined), {})
})

const aliasTable = { '@': 'resources/js', '@blog': 'modules/blog/resources/js' }

test('resolves the longest alias at a path boundary', () => {
    assert.equal(resolveAlias('@/app.js', aliasTable), 'resources/js/app.js')
    assert.equal(resolveAlias('@blog/app.js', aliasTable), 'modules/blog/resources/js/app.js')
    assert.equal(resolveAlias('@blog', aliasTable), 'modules/blog/resources/js')
    assert.equal(resolveAlias('@blogs/app.js', aliasTable), null)
    assert.equal(resolveAlias('resources/js/app.js', aliasTable), null)
})

test('entries are cleaned like the framework cleans them, and refused outside the project', () => {
    // The same cases as framework/vite/aliases_test.go.
    const cases = {
        'a/./b': 'a/b',
        '/resources/js/app.js': 'resources/js/app.js',
        '@/app.js': 'resources/js/app.js',
        '@blog/app.js': 'modules/blog/resources/js/app.js',
        '/@blog/app.js': 'modules/blog/resources/js/app.js',
        '@blog': 'modules/blog/resources/js',
        '@blog/../assets/x.jpg': 'modules/blog/resources/assets/x.jpg',
        '@/../../x': 'x',
    }
    for (const [entry, expected] of Object.entries(cases)) {
        assert.equal(resolveEntry(entry, aliasTable), expected, entry)
    }

    for (const entry of ['..', '../x', '@blog/../../../../../.env', '@/../../../x', '//etc/passwd']) {
        assert.throws(() => resolveEntry(entry, aliasTable), /outside the project/, entry)
    }

    assert.throws(
        () => resolveEntry('@x/app.js', aliasTable),
        { message: 'goravel-vite-plugin: no alias matches "@x/app.js" (from artisan vite:inputs). Known aliases: @, @blog.' },
    )
})

test('a discovered @ entry is built as the file it names, once', async () => {
    const root = project(blogFiles)
    const alias = { '@blog': '/modules/blog/resources/js' }
    const found = {
        inputs: ['@/app.js', '@blog/app.js', 'modules/blog/resources/js/app.js', '/resources/js/./app.js'],
        assets: ['@blog/../assets/logo.svg'],
    }

    const config = await resolve(root, goravel({ discovered: found }), { resolve: { alias } })
    assert.deepEqual(inputOf(config), ['resources/js/app.js', 'modules/blog/resources/js/app.js'])

    await assert.rejects(
        resolve(root, goravel({ discovered: { inputs: ['@x/app.js'], assets: [] } }), { resolve: { alias } }),
        /no alias matches "@x\/app.js" \(from artisan vite:inputs\)\. Known aliases: @, @blog\./,
    )
    await assert.rejects(resolve(root, goravel({ discovered: { inputs: ['../x.js'], assets: [] } })), /"\.\.\/x\.js" resolves to "\.\.\/x\.js", outside the project/)

    await build({ configFile: false, logLevel: 'silent', root, resolve: { alias }, plugins: goravel({ discovered: found }) })

    // The table joins the manifest for the application, and the chunks are untouched.
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/build/.vite/manifest.json'), 'utf8'))
    assert.deepEqual(manifest['goravel:aliases'], { '@': 'resources/js', '@blog': 'modules/blog/resources/js' })
    assert.ok(manifest['modules/blog/resources/js/app.js'].isEntry)
    assert.ok(manifest['resources/js/app.js'].isEntry)
    assert.match(manifest['modules/blog/resources/assets/logo.svg'].file, /^assets\/logo-[\w-]+\.svg$/)
})

test('the hot file carries the alias table', async () => {
    const root = project(blogFiles)

    const server = await createServer({
        configFile: false,
        logLevel: 'silent',
        root,
        resolve: { alias: [{ find: '@blog', replacement: '/modules/blog/resources/js' }] },
        server: { host: '127.0.0.1', port: 0 },
        plugins: goravel({ input: appInput, discover: false }),
    })
    const hotFile = path.join(root, 'public', 'hot')

    try {
        await server.listen()

        const content = fs.readFileSync(hotFile, 'utf8')
        assert.equal(content.includes('\n'), false)
        assert.deepEqual(JSON.parse(content), {
            url: `http://127.0.0.1:${server.httpServer.address().port}`,
            aliases: { '@blog': 'modules/blog/resources/js', '@': 'resources/js' },
        })
    } finally {
        await server.close()
    }

    assert.equal(fs.existsSync(hotFile), false)
})
