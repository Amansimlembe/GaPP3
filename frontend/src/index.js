import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { Provider } from 'react-redux';
import { store } from './store';

class ErrorBoundary extends React.Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Uncaught error:', error, errorInfo);
    // Clear stale data to prevent stuck states
    try {
      localStorage.clear();
      indexedDB.deleteDatabase('ChatDB');
      console.log('Cleared localStorage and IndexedDB due to critical error');
    } catch (err) {
      console.error('Failed to clear storage:', err);
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900">
          <div className="text-center">
            <h1 className="text-2xl text-red-500 mb-4">Something went wrong</h1>
            <p className="text-gray-600 dark:text-gray-300">
              Please <a href="/" className="text-blue-500 hover:underline">refresh the page</a> or try again later.
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  console.error('No root element found in DOM');
  document.body.innerHTML = '<h1>Error: Root element not found</h1>';
} else {
  console.log('Root element found, mounting React app');
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <Provider store={store}>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </Provider>
    </React.StrictMode>
  );
  console.log('React app mounted successfully');
}