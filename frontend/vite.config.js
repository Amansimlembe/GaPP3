export default {
  build: {
    sourcemap: true,
    minify: 'terser',
    terserOptions: {
      mangle: {
        keep_names: true,
      },
    },
  },
};