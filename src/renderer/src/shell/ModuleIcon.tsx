import { icons, Package } from 'lucide-react'
import type { LucideProps } from 'lucide-react'

interface Props extends LucideProps {
  name: string
}

/** Renders a lucide icon by its PascalCase name from module.json; falls back to a box. */
export default function ModuleIcon({ name, ...rest }: Props): React.JSX.Element {
  const Icon = (icons as Record<string, React.ComponentType<LucideProps>>)[name] ?? Package
  return <Icon {...rest} />
}
