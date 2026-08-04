import { mount } from 'svelte';
import App from './App.svelte';
import './styles.css';

const appTarget = document.getElementById('app');

if (!appTarget) {
  throw new Error('Missing application mount target');
}

mount(App, { target: appTarget });
