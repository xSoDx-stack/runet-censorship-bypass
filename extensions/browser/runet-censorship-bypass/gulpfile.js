'use strict';

const gulp = require('gulp');
const del = require('del');

const clean = function(cb) {
  del.sync('./build');
  return cb();
};

const cleanChrome = function(cb) {
  del.sync('./build/extension-chromium');
  return cb();
};

const cleanFirefox = function(cb) {
  del.sync('./build/extension-firefox');
  return cb();
};

const commonSrc = [
  './src/extension-common/**/*',
  '!./src/extension-common/**/*.tmpl.*',
  '!./src/extension-common/**/.gitignore',
];
const chromiumDst = './build/extension-chromium';
const firefoxDst = './build/extension-firefox';

const copyChromium = function() {
  return gulp.src(commonSrc, { encoding: false })
    .pipe(gulp.dest(chromiumDst));
};

const firefoxCommonSrc = [
  ...commonSrc,
  '!./src/extension-common/manifest.json',
];

const copyFirefoxCommon = function() {
  return gulp.src(firefoxCommonSrc, { encoding: false })
    .pipe(gulp.dest(firefoxDst));
};

const copyFirefoxOverrides = function() {
  return gulp.src('./src/extension-firefox/**/*', { encoding: false })
    .pipe(gulp.dest(firefoxDst));
};

const copyFirefox = gulp.series(copyFirefoxCommon, copyFirefoxOverrides);
const buildChrome = gulp.series(cleanChrome, copyChromium);
const buildFirefox = gulp.series(cleanFirefox, copyFirefox);
const buildTargets = gulp.series(clean, gulp.parallel(copyChromium, copyFirefox));

// Backward-compatible task used by the existing `npm run release` command.
// Cross-browser builds use `buildTargets` through `npm run release:all`.
const buildAll = buildChrome;

module.exports = {
  default: buildAll,
  buildChrome,
  buildFirefox,
  buildTargets,
  buildAll,
};

