import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEncryptedFileSummarySecretStore } from '../server/summary/secret-store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    fs.rm(root, { recursive: true, force: true })))
})

describe('encrypted summary secret store', () => {
  it('restores a credential after a new store instance without writing plaintext', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-secrets-'))
    roots.push(root)
    const first = await createEncryptedFileSummarySecretStore(root)
    await first.set('custom-summary', 'private-api-key')

    const second = await createEncryptedFileSummarySecretStore(root)
    expect(await second.get('custom-summary')).toBe('private-api-key')
    expect(await fs.readFile(path.join(root, 'summary-secrets.json'), 'utf8'))
      .not.toContain('private-api-key')
    expect((await fs.stat(path.join(root, 'summary-secrets.key'))).mode & 0o777)
      .toBe(0o600)
    expect((await fs.stat(path.join(root, 'summary-secrets.json'))).mode & 0o777)
      .toBe(0o600)
  })

  it('preserves concurrent credential updates', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'agent-trajectory-secrets-race-'))
    roots.push(root)
    const store = await createEncryptedFileSummarySecretStore(root)

    await Promise.all([
      store.set('first', 'private-first'),
      store.set('second', 'private-second'),
    ])

    expect(await store.get('first')).toBe('private-first')
    expect(await store.get('second')).toBe('private-second')
    const persisted = await createEncryptedFileSummarySecretStore(root)
    expect(await persisted.get('first')).toBe('private-first')
    expect(await persisted.get('second')).toBe('private-second')
  })
})
