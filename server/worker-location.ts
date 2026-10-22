import { pathToFileURL } from 'node:url'

export function workerLocation(
  environmentVariable: string,
  developmentLocation: URL,
): URL {
  const packagedLocation = process.env[environmentVariable]
  return packagedLocation === undefined
    ? developmentLocation
    : pathToFileURL(packagedLocation)
}
