import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** A small link that opens something on GitHub in the browser. */
export function OnGitHub({ url, icon, className }: { url: string; icon?: boolean; className?: string }) {
  return (
    <Button variant="link" size="xs" className={cn('h-auto px-0', className)} onClick={() => void window.api.openExternal(url)}>
      {icon && <ExternalLink aria-hidden />}
      On GitHub
    </Button>
  )
}
