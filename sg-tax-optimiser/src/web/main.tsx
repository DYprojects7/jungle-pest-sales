import { render } from 'preact';
import { App } from './App';
import { loadWebFonts } from './fonts';
import './styles.css';

const mount = document.getElementById('app');
if (mount) render(<App />, mount);
loadWebFonts();
