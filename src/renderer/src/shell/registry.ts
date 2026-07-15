import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { ModuleManifest } from '@shared/types'

/**
 * Build-time module discovery. Drop a folder with module.json + index.tsx
 * into /modules and it appears here — no shell code changes.
 */
const manifests = import.meta.glob<ModuleManifest>('@modules/*/module.json', {
  eager: true,
  import: 'default'
})

const components = import.meta.glob<{ default: ComponentType }>('@modules/*/index.tsx')

export interface RegisteredModule {
  manifest: ModuleManifest
  Component: LazyExoticComponent<ComponentType>
}

function dirOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/'))
}

const byDir = new Map<string, ModuleManifest>()
for (const [path, manifest] of Object.entries(manifests)) {
  byDir.set(dirOf(path), manifest)
}

export const modules: RegisteredModule[] = Object.entries(components)
  .map(([path, loader]) => {
    const manifest = byDir.get(dirOf(path))
    if (!manifest) return null
    return { manifest, Component: lazy(loader) }
  })
  .filter((m): m is RegisteredModule => m !== null)
  .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))

export function moduleById(id: string): RegisteredModule | undefined {
  return modules.find((m) => m.manifest.id === id)
}
