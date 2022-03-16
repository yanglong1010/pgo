#!/usr/bin/env node

// pgo --lang=python --init-dir=code/src
'use strict';
const PGOComponent = require('../dist/main').default
let pgo = new PGOComponent({});
pgo.index({argsObj: process.argv.slice(2)})
