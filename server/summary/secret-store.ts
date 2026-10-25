import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { SerialTransaction, writePrivateJson } from './file-transaction'
import type { SummarySecretStore } from './types'

interface SecretCodec {
  decrypt(value: Buffer): string
  encrypt(value: string): Buffer
}

export class EncryptedFileSummarySecretStore implements SummarySecretStore {
  private values?: Record<string, string>
  private readonly transaction = new SerialTransaction()

  constructor(
    private readonly file: string,
    private readonly codec: SecretCodec,
  ) {}

  private async read(): Promise<Record<string, string>> {
    if (this.values !== undefined) return this.values
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as unknown
      this.values = parsed !== null && typeof parsed === 'object'
        ? Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.values = {}
    }
    return this.values
  }

  private async write(values: Record<string, string>): Promise<void> {
    await writePrivateJson(this.file, values)
    this.values = values
  }

  async get(id: string): Promise<string | undefined> {
    return this.transaction.run(async () => {
      const encoded = (await this.read())[id]
      if (encoded === undefined) return undefined
      return this.codec.decrypt(Buffer.from(encoded, 'base64'))
    })
  }

  async set(id: string, value: string): Promise<void> {
    await this.transaction.run(async () => {
      const values = await this.read()
      await this.write({
        ...values,
        [id]: this.codec.encrypt(value).toString('base64'),
      })
    })
  }

  async delete(id: string): Promise<void> {
    await this.transaction.run(async () => {
      const values = { ...await this.read() }
      delete values[id]
      await this.write(values)
    })
  }
}

const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

async function secretKey(file: string): Promise<Buffer> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  try {
    const key = await fs.readFile(file)
    if (key.length !== KEY_BYTES) throw new Error('invalid summary secret key')
    await fs.chmod(file, 0o600)
    return key
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const generated = randomBytes(KEY_BYTES)
  try {
    await fs.writeFile(file, generated, { mode: 0o600, flag: 'wx' })
    return generated
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const key = await fs.readFile(file)
    if (key.length !== KEY_BYTES) throw new Error('invalid summary secret key')
    await fs.chmod(file, 0o600)
    return key
  }
}

export async function createEncryptedFileSummarySecretStore(
  dataRoot: string,
): Promise<SummarySecretStore> {
  const key = await secretKey(path.join(dataRoot, 'summary-secrets.key'))
  const codec: SecretCodec = {
    encrypt(value) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([
        cipher.update(value, 'utf8'),
        cipher.final(),
      ])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    },
    decrypt(value) {
      if (value.length < IV_BYTES + TAG_BYTES) {
        throw new Error('invalid encrypted summary secret')
      }
      const iv = value.subarray(0, IV_BYTES)
      const tag = value.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
      const encrypted = value.subarray(IV_BYTES + TAG_BYTES)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]).toString('utf8')
    },
  }
  return new EncryptedFileSummarySecretStore(
    path.join(dataRoot, 'summary-secrets.json'),
    codec,
  )
}
