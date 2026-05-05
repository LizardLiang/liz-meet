'use strict';
// electron-rebuild puts its output in build/Release/ (for addons without node-pre-gyp).
// A versioned bin/{platform}-{arch}-{abi}/ binary takes precedence if present,
// but we fall back to build/Release/ which is always the freshest rebuild.
const path = require('path');
const { existsSync } = require('fs');

const abi = process.versions.modules;
const versionedBin = path.join(
  __dirname,
  `bin/${process.platform}-${process.arch}-${abi}/loopback-capture.node`,
);
const releaseBin = path.join(__dirname, 'build', 'Release', 'loopback_capture.node');

module.exports = existsSync(versionedBin) ? require(versionedBin) : require(releaseBin);
