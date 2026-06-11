module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    // Rewrites `import.meta` so the web bundle (dev server + export) doesn't
    // throw "Cannot use 'import.meta' outside a module". See the plugin file.
    plugins: ["./babel-plugin-import-meta.js"]
  };
};
