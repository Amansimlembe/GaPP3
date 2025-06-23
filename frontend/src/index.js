// index.js
import React from 'react';
import ReactDOM from 'react-dom';
import App from './App';
import { Provider } from 'react-redux';
import { store, initializeStore } from './store';

// Bootstrap app after store initialization
const bootstrap = async () => {
  try {
    await initializeStore();
  } catch (error) {
    console.error('Failed to initialize store:', error);
    // Proceed with rendering using default store state
  }
  ReactDOM.render(
    <Provider store={store}>
      <App />
    </Provider>,
    document.getElementById('root')
  );
};

bootstrap();