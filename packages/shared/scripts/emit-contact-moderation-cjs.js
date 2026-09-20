#!/usr/bin/env node
// Emits the contact-information detector as a dependency-free CommonJS module
// for server.me (utils/contactModeration.js). The TypeScript source in
// src/moderation/patterns.ts is the only implementation; this copies the
// compiled output verbatim (minus the source map) and inlines the one enum it
// imports. Both repositories assert the golden corpus in
// src/moderation/__fixtures__/contact-vectors.json, and the release harness
// checks that the two corpus files are byte-identical — so a mirror that
// drifts fails release verification.
//
//   npm run build:shared
//   node packages/shared/scripts/emit-contact-moderation-cjs.js <target-path>
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const target = process.argv[2];
if (!target) {
  console.error('usage: emit-contact-moderation-cjs.js <target-path>');
  process.exit(2);
}
const compiled = path.resolve(__dirname, '../dist/moderation/patterns.js');
let js = fs.readFileSync(compiled, 'utf8');
js = js.replace(/\/\/# sourceMappingURL=.*\n?$/m, '');
const importLine = 'const chat_types_1 = require("../types/chat.types");';
if (!js.includes(importLine)) throw new Error('unexpected compiled output: import line not found');
js = js.replace(importLine, "const chat_types_1 = { ModerationStatus: { CLEAN: 'clean', FLAGGED: 'flagged', BLOCKED: 'blocked' } };");
let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: path.resolve(__dirname, '../../..') }).toString().trim();
} catch {
  /* not a git checkout */
}
const header = `// GENERATED FILE — do not edit by hand.
// Contact-information detector, emitted from majestic-chat
// packages/shared/src/moderation/patterns.ts (commit ${commit}) by
// packages/shared/scripts/emit-contact-moderation-cjs.js. The TypeScript
// source is the only implementation; tests/batch-s/contact-moderation.test.js
// asserts the shared golden corpus (tests/batch-s/fixtures/contact-vectors.json)
// against this file, and the release harness checks the corpus is
// byte-identical in both repositories. Regenerate after any change there:
//   (majestic-chat) npm run build:shared && node packages/shared/scripts/emit-contact-moderation-cjs.js ../server.me/utils/contactModeration.js
/* eslint-disable */
`;
fs.writeFileSync(target, header + js);
console.log(`wrote ${target} (${js.length} bytes, source commit ${commit})`);
