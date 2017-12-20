import commandExists = require('command-exists')
import { spawn } from 'cross-spawn'
import * as fs from 'fs'
import * as path from 'path'
import * as request from 'request'
import * as unzip from 'unzip'
import { padEnd } from 'lodash'
import { Context } from '../..'
import { defaultBoilerplates } from './boilerplates'
import { getZipInfo } from './utils'

export const command = 'create <directory>'
export const describe = 'Bootstrap a new GraphQL project'

export const builder = {
  boilerplate: {
    alias: 'b',
    describe: 'URL to boilerplate GitHub repostiory',
    type: 'string',
  },
}

export async function handler(
  context: Context,
  argv: { boilerplate?: string; verbose: boolean; directory: string },
) {
  if (argv.directory.match(/[A-Z]/)) {
    console.log(
      `Project/directory name cannot contain uppercase letters: ${
        argv.directory
      }`,
    )
  }

  // make sure that project directory is empty
  const projectPath = path.resolve(argv.directory)

  if (fs.existsSync(projectPath)) {
    const allowedFiles = ['.git', '.gitignore']
    const conflictingFiles = fs
      .readdirSync(projectPath)
      .filter(f => !allowedFiles.includes(f))

    if (conflictingFiles.length > 0) {
      console.log(`Directory ${argv.directory} must be empty.`)
      return
    }
  } else {
    fs.mkdirSync(projectPath)
  }

  // determine boilerplate
  let { boilerplate } = argv

  // allow short handle boilerplate (e.g. `node-basic`)
  if (boilerplate && !boilerplate.startsWith('http')) {
    const matchedBoilerplate = defaultBoilerplates.find(
      b => b.name === boilerplate,
    )
    if (matchedBoilerplate) {
      boilerplate = matchedBoilerplate.repo
    }
  }

  // interactive selection
  if (!boilerplate) {
    const maxNameLength = defaultBoilerplates
      .map(bp => bp.name.length)
      .reduce((max, x) => Math.max(max, x), 0)
    const choices = defaultBoilerplates.map(
      bp => `${padEnd(bp.name, maxNameLength + 2)} ${bp.description}`,
    )
    const { choice } = await context.prompt({
      type: 'list',
      name: 'choice',
      message: `Choose GraphQL boilerplate project:`,
      choices,
    })

    boilerplate = defaultBoilerplates[choices.indexOf(choice)].repo
  }

  // download repo contents
  const zipInfo = getZipInfo(boilerplate!)
  const downloadUrl = zipInfo.url

  console.log(`[graphql create] Downloading boilerplate from ${downloadUrl}...`)

  await new Promise(resolve => {
    request(downloadUrl)
      .pipe(unzip.Parse())
      // extracts zip content from `zipInfo.path` to `projectPath`
      .on('entry', entry => {
        if (entry.type === 'Directory' && entry.path.startsWith(zipInfo.path)) {
          const relativePath = path.relative(zipInfo.path, entry.path)
          const targetPath = path.resolve(projectPath, relativePath)
          if (!fs.existsSync(targetPath)) {
            fs.mkdirSync(path.resolve(projectPath, relativePath))
          }
        }
        if (entry.type === 'File' && entry.path.startsWith(zipInfo.path)) {
          const relativePath = path.relative(zipInfo.path, entry.path)
          const targetPath = path.resolve(projectPath, relativePath)
          entry.pipe(fs.createWriteStream(targetPath))
        } else {
          entry.autodrain()
        }
      })
      .on('close', resolve)
  })

  // run npm/yarn install
  let { verbose } = argv
  const subDirs = fs
    .readdirSync(projectPath)
    .map(f => path.join(projectPath, f))
    .filter(f => fs.statSync(f).isDirectory())
  const installPaths = [projectPath, ...subDirs]
    .map(dir => path.join(dir, 'package.json'))
    .filter(p => fs.existsSync(p))

  for (const packageJsonPath of installPaths) {
    process.chdir(path.dirname(packageJsonPath))
    console.log(
      `[graphql create] Installing node dependencies for ${packageJsonPath}...`,
    )
    if (commandExists.sync('yarn')) {
      await shell('yarn install')
    } else {
      await shell('npm install')
    }
  }

  // change dir to projectPath for install steps
  process.chdir(projectPath)

  // run & delete setup script
  const installPath = path.join(projectPath, 'install.js')
  if (fs.existsSync(installPath)) {
    console.log(`[graphql create] Running boilerplate install script... `)
    const installFunction = require(installPath)

    await installFunction({ project: argv.directory })

    fs.unlinkSync(installPath)
  }
}

function shell(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const commandParts = command.split(' ')
    const cmd = spawn(commandParts[0], commandParts.slice(1), {
      cwd: process.cwd(),
      detached: false,
      stdio: 'inherit',
    })

    cmd.on('error', reject)
    cmd.on('close', resolve)
  })
}
