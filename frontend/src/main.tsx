import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import DebugApp from './DebugApp.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DebugApp />
  </StrictMode>,
)
