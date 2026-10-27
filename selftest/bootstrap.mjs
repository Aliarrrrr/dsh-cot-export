/**
 * Self-test runtime preparation for dsh-cot-export.
 *
 * The plugin's Host half imports two bare specifiers that only exist inside a
 * running Harness (`@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`). So the
 * harness copies `lib/` into a throwaway directory and writes minimal stand-ins
 * next to it, which keeps the repository's tests runnable from a clean checkout
 * with no install step and no network.
 *
 * Nothing here is used by the installed plugin.
 */

import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(here, '..')

const TOOLS_STUB = `/** Self-test stand-in for the definition builder: the registry accepts a plain definition object. */
export function defineTool(definition) {
  return definition
}
`

const SCHEMASTERY_STUB = `/** Self-test stand-in for schemastery: only the chainable builders this plugin declares. */
const chainable = (type) => {
  const node = { type }
  node.default = (value) => ({ type, default: value })
  return node
}

const z = {
  object: (shape) => ({ type: 'object', shape }),
  string: () => chainable('string'),
  number: () => chainable('number'),
  boolean: () => chainable('boolean'),
}

export default z
`

const writePackage = (directory, name) =>
  writeFile(
    path.join(directory, 'package.json'),
    `${JSON.stringify({ name, version: '0.0.0-selftest', type: 'module', main: 'index.js', exports: { '.': './index.js' } }, null, 2)}\n`,
    'utf8',
  )

/**
 * Copy the plugin into a temporary directory with the two stubs in place.
 * @returns {Promise<{root: string, pluginUrl: string, clientUrl: string}>} paths for the harness.
 */
export async function prepareRuntime() {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-cot-export-selftest-'))
  // The copied lib is ESM in `.js` files, so the throwaway root declares the
  // module type just like the package does.
  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'dsh-cot-export-selftest-runtime', private: true, type: 'module' }, null, 2)}\n`,
    'utf8',
  )
  await cp(path.join(packageRoot, 'lib'), path.join(root, 'lib'), { recursive: true })

  const scoped = path.join(root, 'node_modules', '@deepseek-ai')
  const toolsDir = path.join(scoped, 'dsh-tools')
  const schemasteryDir = path.join(scoped, 'schemastery')
  await mkdir(toolsDir, { recursive: true })
  await mkdir(schemasteryDir, { recursive: true })
  await writePackage(toolsDir, '@deepseek-ai/dsh-tools')
  await writeFile(path.join(toolsDir, 'index.js'), TOOLS_STUB, 'utf8')
  await writePackage(schemasteryDir, '@deepseek-ai/schemastery')
  await writeFile(path.join(schemasteryDir, 'index.js'), SCHEMASTERY_STUB, 'utf8')

  return {
    root,
    pluginUrl: pathToFileURL(path.join(root, 'lib', 'index.js')).href,
    clientUrl: pathToFileURL(path.join(root, 'lib', 'client.js')).href,
  }
}

export { packageRoot }
