import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './App.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
