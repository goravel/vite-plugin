import fs from 'node:fs'
import path from 'node:path'
import type { AliasOptions } from 'vite'

/** The manifest key the alias table is written under; no source path contains a colon. */
export const aliasesKey = 'goravel:aliases'

/**
 * The aliases the application can resolve in `{{ vite "@/app.js" }}`: those whose name starts
 * with `@` and whose replacement is a directory inside the root, as root-relative slash paths.
 * The first alias of a name wins, as in Vite.
 */
export function collectAliases(root: string, alias: AliasOptions | undefined): Record<string, string> {
    const entries = Array.isArray(alias)
        ? alias.map(({ find, replacement }) => [find, replacement] as const)
        : Object.entries((alias ?? {}) as Record<string, string>)
    const aliases: Record<string, string> = {}

    for (const [find, replacement] of entries) {
        if (typeof find !== 'string' || !find.startsWith('@') || typeof replacement !== 'string' || find in aliases) {
            continue
        }

        const directory = aliasDirectory(root, replacement)
        if (directory !== null) {
            aliases[find] = directory
        }
    }

    return aliases
}

/** A replacement as a directory relative to the root: an absolute path inside it, or a root-relative `/path`. */
function aliasDirectory(root: string, replacement: string): string | null {
    if (!path.isAbsolute(replacement) && !replacement.startsWith('/')) {
        return null
    }

    for (const candidate of [path.resolve(replacement), path.join(root, replacement)]) {
        const relative = path.relative(root, candidate)

        if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).includes('node_modules')) {
            continue
        }

        if (fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) {
            return relative.split(path.sep).join('/')
        }
    }

    return null
}

/** Replaces a leading alias, the longest first, at a path boundary: `@` never captures `@blog/...`. Null when none matches. */
export function resolveAlias(entry: string, aliases: Record<string, string>): string | null {
    let found: string | undefined

    for (const alias of Object.keys(aliases)) {
        if ((entry === alias || entry.startsWith(alias + '/')) && alias.length > (found?.length ?? 0)) {
            found = alias
        }
    }

    return found === undefined ? null : aliases[found] + entry.slice(found.length)
}

/**
 * An entry as the manifest names it, the same way the framework resolves it: without a leading
 * slash, its alias replaced, cleaned of `.` and `..`, and refused when it leaves the project.
 */
export function resolveEntry(entry: string, aliases: Record<string, string>): string {
    let resolved = entry.replace(/^\//, '')

    if (resolved.startsWith('@')) {
        const replaced = resolveAlias(resolved, aliases)

        if (replaced === null) {
            const known = Object.keys(aliases).sort()

            throw new Error(
                `goravel-vite-plugin: no alias matches "${entry}" (from artisan vite:inputs). ` +
                    (known.length > 0 ? `Known aliases: ${known.join(', ')}.` : 'No alias points inside the project.'),
            )
        }

        resolved = replaced
    }

    const cleaned = path.posix.normalize(resolved.replaceAll('\\', '/')).replace(/\/+$/, '')

    if (cleaned === '..' || cleaned.startsWith('../') || cleaned.startsWith('/') || path.win32.isAbsolute(cleaned)) {
        throw new Error(`goravel-vite-plugin: "${entry}" resolves to "${cleaned}", outside the project`)
    }

    return cleaned === '' ? '.' : cleaned
}
