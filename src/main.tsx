import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/shell.css'
import './styles/conversation.css'
import './styles/timeline-ledger.css'
import './styles/inspector.css'
import './styles/states-responsive.css'
import './styles/summary.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
