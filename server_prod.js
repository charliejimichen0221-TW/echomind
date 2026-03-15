/**
 * Production server entry point for HuggingFace Spaces deployment.
 * Serves the pre-built Vite frontend from dist/ and handles API routes.
 * 
 * This is a thin wrapper that:
 * 1. Sets NODE_ENV=production so server.ts uses express.static instead of Vite dev server
 * 2. Uses port 7860 (HuggingFace Spaces default)
 */

// Force production mode
process.env.NODE_ENV = 'production';

// HuggingFace Spaces expects port 7860
process.env.PORT = '7860';

// Import and run the main server
import('./server.ts');
