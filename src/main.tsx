import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { blockInspect } from './lib/blockInspect';

blockInspect();

createRoot(document.getElementById('root')!).render(<App />);
