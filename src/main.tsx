import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { blockInspect } from './lib/blockInspect';
import { installStaleBuildReload } from './lib/staleBuild';

blockInspect();
installStaleBuildReload();

createRoot(document.getElementById('root')!).render(<App />);
