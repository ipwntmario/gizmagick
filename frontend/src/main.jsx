import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './themes.css'
import './high-contrast.css'
import './hacker.css'
import './theme-picker.css'
import './pink-splash-original.css'
import './medium-contrast-v1.css'
import './medium-contrast.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
