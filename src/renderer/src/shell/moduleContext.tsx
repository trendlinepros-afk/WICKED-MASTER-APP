import { createContext, useContext, type ReactNode } from 'react'

/**
 * The shell tells each mounted module its CURRENT display name — the user's card
 * rename (moduleOverrides) if set, otherwise the module.json name. Modules render
 * `<ModuleTitle>` (or `useModuleName`) in their in-app header so renaming a tool's
 * card on the home screen updates the name inside the tool too, automatically.
 */
const ModuleNameContext = createContext<string>('')

export function ModuleNameProvider({ name, children }: { name: string; children: ReactNode }): React.JSX.Element {
  return <ModuleNameContext.Provider value={name}>{children}</ModuleNameContext.Provider>
}

/** The tool's effective name, or `fallback` when rendered outside the shell. */
export function useModuleName(fallback = ''): string {
  const name = useContext(ModuleNameContext)
  return name || fallback
}

/**
 * Drop-in for a hardcoded name in a heading: `<h1><ModuleTitle fallback="Foo" /></h1>`.
 * Shows the shell-provided effective name, falling back to `fallback`.
 */
export function ModuleTitle({ fallback }: { fallback: string }): React.JSX.Element {
  return <>{useModuleName(fallback)}</>
}
