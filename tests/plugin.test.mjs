import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { build, createServer, resolveConfig } from 'vite'
import goravel, { refreshPaths } from '../dist/index.js'

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
        'resources/js/app.js': "import '../css/app.css'\nimport { greet } from '@/greet.js'\nexport const message = greet('vite')\n",
        'resources/js/greet.js': 'export const greet = (name) => `hello ${name}`\n',
        'resources/css/app.css': 'body { color: red; }\n',
        ...files,
    })

    process.chdir(root)

    return fs.realpathSync(root)
}

function write(root, files) {
    for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
        fs.writeFileSync(path.join(root, file), content)
    }
}

function resolve(root, plugins, inlineConfig = {}, command = 'build') {
    return resolveConfig({ configFile: false, logLevel: 'silent', root, plugins, ...inlineConfig }, command)
}

/** The paths handed to the full-reload plugins, which only act on the dev server. */
function refreshedPaths(plugins) {
    return plugins.flat(Infinity).flatMap((plugin) => plugin.__goravel_plugin_config?.paths ?? [])
}

/** The entry points of the resolved build, under whichever key this Vite uses. */
function inputOf(config) {
    return (config.build.rolldownOptions ?? config.build.rollupOptions).input
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

    // Files of the assets option are built although nothing imports them.
    const logo = manifest['resources/images/logo.svg']
    assert.match(logo.file, /^assets\/logo-[\w-]+\.svg$/)
    assert.ok(fs.existsSync(path.join(root, 'public/build', logo.file)))

    // Nothing of public/ itself is copied around, and no hot file is left behind.
    assert.equal(fs.existsSync(path.join(root, 'public/hot')), false)
})

test('the dev server announces itself in the hot file', async () => {
    const root = project({ '.env': 'APP_URL=http://localhost:3000\n' })

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
        assert.equal(fs.readFileSync(hotFile, 'utf8'), `http://127.0.0.1:${port}`)

        // Served code refers to the dev server, not the placeholder origin.
        const result = await server.transformRequest('/resources/js/app.js')
        assert.doesNotMatch(result.code, /__goravel_vite_placeholder__/)

        // Opening the dev server itself explains where the application is.
        const response = await fetch(`http://127.0.0.1:${port}/index.html`)
        assert.equal(response.status, 404)
        assert.match(await response.text(), /href="http:\/\/localhost:3000"/)
    } finally {
        await server.close()
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
        assert.equal(fs.readFileSync(path.join(root, 'storage', 'vite.hot'), 'utf8'), `http://127.0.0.1:${port}`)

        const result = await server.transformRequest('/resources/js/greet.js')
        assert.match(result.code, /hi \$\{name\}/)
        assert.deepEqual([...new Set(seen)], [`http://127.0.0.1:${port}`])
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
    assert.ok(Array.isArray(refreshPaths))
})

test('refuses to start the dev server in CI unless told otherwise', async () => {
    const root = project({ '.env': 'CI=1\n' })

    await assert.rejects(() => resolve(root, goravel({ input: appInput, discover: false }), {}, 'serve'), /should not run the Vite HMR server in CI/)

    const bypassed = await resolve(root, goravel({ input: appInput, discover: false }), { envDir: writeEnv(root, 'CI=1\nGORAVEL_BYPASS_ENV_CHECK=1\n') }, 'serve')
    assert.equal(bypassed.command, 'serve')

    const built = await resolve(root, goravel({ input: appInput, discover: false }))
    assert.equal(built.command, 'build')
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
function fakeArtisan(root, output, { exitCode = 0, prefix = '' } = {}) {
    write(root, {
        'artisan.cjs':
            `require('node:fs').appendFileSync(${JSON.stringify(path.join(root, 'calls.log'))}, process.argv.slice(2).join(' ') + '\\n')\n` +
            (prefix ? `console.log(${JSON.stringify(prefix)})\n` : '') +
            `console.log(${JSON.stringify(typeof output === 'string' ? output : JSON.stringify(output))})\n` +
            `process.exit(${exitCode})\n`,
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
        assert.equal(fs.readFileSync(path.join(root, 'tmp', 'hot'), 'utf8'), `http://127.0.0.1:${port}`)
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
        assert.equal(fs.readFileSync(path.join(root, 'storage', 'vite.hot'), 'utf8'), `http://127.0.0.1:${port}`)
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

    await assert.rejects(
        () => resolve(root, goravel({ discoverCommand: fakeArtisan(root, { inputs: [], assets: [] }) })),
        /nothing to build/,
    )
})
