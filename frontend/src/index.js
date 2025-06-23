import React from 'react';
import { createRoot } from 'react-dom/client'; // Updated to createRoot for React 18
import App from './App';
import { Provider } from 'react-redux';
import { store, initializeStore } from './store';

// Error boundary component to catch render errors
class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Caught in ErrorBoundary:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return <div>Something went wrong: {this.state.error?.message}</div>;
    }
    return this.props.children;
  }
}

// Bootstrap app after store initialization
const bootstrap = async () => {
  try {
    await initializeStore(); // Ensure store is hydrated before rendering
  } catch (error) {
    console.error('Failed to initialize store:', error);
    // Log error but proceed with rendering using default store state
  }

  const root = createRoot(document.getElementById('root')); // Use createRoot
  root.render(
    <React.StrictMode> {/* Keep StrictMode for development debugging */}
      <Provider store={store}>
        <ErrorBoundary> {/* Wrap app in error boundary */}
          <App />
        </ErrorBoundary>
      </Provider>
    </React.StrictMode>
  );
};

bootstrap();