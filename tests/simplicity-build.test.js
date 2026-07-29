import { readFile } from 'node:fs/promises'

describe('Simplicity binding release configuration', () => {
  it('pins an immutable LWK revision and enables only the Simplicity feature', async () => {
    const config = JSON.parse(await readFile(new URL('../simplicity-bindings.json', import.meta.url), 'utf8'))
    expect(config.repository).toMatch(/^https:\/\/github\.com\/[^/]+\/lwk\.git$/)
    expect(config.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(config.target).toBe('bundler')
    expect(config.features).toEqual(['simplicity'])
    expect(config.rustToolchain).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('keeps the build locked and validates the required runtime exports', async () => {
    const script = await readFile(new URL('../scripts/build-lwk-simplicity.mjs', import.meta.url), 'utf8')
    expect(script).toContain("'--locked'")
    expect(script.indexOf("'--out-dir'")).toBeLessThan(script.indexOf("'--locked'"))
    for (const symbol of [
      'SimplicityProgram',
      'SimplicityArguments',
      'SimplicityTypedValue',
      'simplicityDeriveXonlyPubkey',
      'blind(pset'
    ]) {
      expect(script).toContain(symbol)
    }
  })
})
