import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Toaster } from '@/components/ui/sonner'
import type { Api } from '../../shared/types'

declare global {
  interface Window {
    api: Api
  }
}

createRoot(document.getElementById('root')!).render(
  <TooltipProvider delayDuration={100}>
    <App />
    <Toaster position="bottom-center" offset={20} duration={2200} />
  </TooltipProvider>
)
