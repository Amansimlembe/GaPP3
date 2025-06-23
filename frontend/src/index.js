import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { Provider } from 'react-redux';
import { store, initializeStore } from './store';

const bootstrap = async () => {
  try {
    await initializeStore();
  } catch (error) {
    console.error('Failed to initialize store:', error);
  }
  const root = createRoot(document.getElementById('root'));
  root.render(
    <Provider store={store}>
      <App />
    </Provider>
  );
};

bootstrap();