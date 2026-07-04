import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { registerAiTaskExecutors } from './lib/ai/generateExecutor';

// Executors must exist before any UI renders so restored tasks are retryable.
registerAiTaskExecutors();

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
