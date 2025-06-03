import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { Provider } from 'react-redux';
import { store } from './store';

class ErrorBoundary extends React.Component {
  state = { error: null, errorInfo: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught error:', {
      error: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
      state: this.props.store ? this.props.store.getState() : null,
    });
    this.setState({ error, errorInfo });
  }

  handleRetry = () => {
    this.setState({ error: null, errorInfo: null });
    localStorage.clear();
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-gray-100 dark:bg-gray-900 text-center p-4">
          <h1 className="text-2xl text-red-500 mb-4">Something went wrong</h1>
          <p className="text-gray-700 dark:text-gray-300 mb-6">{this.state.error.message}</p>
          <button
            onClick={this.handleRetry}
            className="bg-primary text-white px-4 py-2 rounded hover:bg-secondary transition"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  console.error('No root element found in DOM');
  document.body.innerHTML = `
    <div style="min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #f3f4f6; text-align: center; padding: 20px;">
      <h1 style="color: #ef4444; font-size: 24px; margin-bottom: 16px;">Error: App failed to load</h1>
      <p style="color: #374151; margin-bottom: 24px;">The application could not start. Please try refreshing the page.</p>
      <button onclick="window.location.reload()" style="background: #4A90E2; color: white; padding: 8px 16px; border-radius: 4px; cursor: pointer;">Refresh</button>
    </div>
  `;
} else {
  console.log('Root element found, rendering App');
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <Provider store={store}>
        <ErrorBoundary store={store}>
          <App />
        </ErrorBoundary>
      </Provider>
    </React.StrictMode>
  );
}



