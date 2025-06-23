



import React from 'react';
import ReactDOM from 'react-dom';
import App from './App';
import { Provider } from 'react-redux';
import { store, initializeStore } from './store';

// Bootstrap app after store initialization
const bootstrap = async () => {
  await initializeStore();
  ReactDOM.render(
    <Provider store={store}>
      <App />
    </Provider>,
    document.getElementById('root')
  );
};

bootstrap();