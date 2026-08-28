'use strict';

const gulp = require('gulp');
const del = require('del');

const clean = function(cb) {
  del.sync('./build');
  return cb();
};

const commonSrc = [
  './src/extension-common/**/*',
  '!./src/extension-common/**/*.tmpl.*',
  '!./src/extension-common/**/.gitignore',
];
const fullDst = './build/extension-full';

const copyFull = function() {
  return gulp.src(commonSrc)
    .pipe(gulp.dest(fullDst));
};

const buildAll = gulp.series(clean, copyFull);

module.exports = {
  default: buildAll,
  buildAll,
};

