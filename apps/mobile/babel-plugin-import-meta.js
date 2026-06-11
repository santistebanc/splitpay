// Rewrites `import.meta` to a web-safe object at transform time.
//
// Why: some dependencies (notably @powersync/web) use `import.meta.url` to
// locate worker assets. Expo's web dev server (`expo start --web`) serves a
// classic, non-module bundle, where `import.meta` is a hard SyntaxError:
//   "Cannot use 'import.meta' outside a module"
// Running this in Babel fixes both the dev server (hot reload) and
// `expo export` in one place, instead of only post-processing the export.
//
// `import.meta`      -> ({ url: <current page href or ''> })
// `import.meta.url`  -> ({ url: ... }).url  === the page href
module.exports = function importMetaToWeb() {
  return {
    name: "transform-import-meta-web",
    visitor: {
      MetaProperty(path) {
        path.replaceWithSourceString(
          "({ url: (typeof globalThis !== 'undefined' && globalThis.location ? globalThis.location.href : '') })"
        );
      }
    }
  };
};
