import './styles.css';
import { startApp } from './app';

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('Missing #app mount point');
}

startApp(app);

