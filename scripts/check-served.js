#!/usr/bin/env node
// Syntax-check the webview scripts AS SERVED (template-literal output).
// `node --check extension.js` cannot catch escaping bugs inside the HTML
// template — a bare \n in the template is a real newline in the served
// script and breaks it silently (static HTML still renders).
const fs = require('fs');
const path = require('path');
const M = require('module');
const orig = M._load;
M._load = function (req, ...a) {
  return req === 'vscode'
    ? new Proxy({}, { get: () => new Proxy(function () {}, { get: () => ({}), construct: () => ({}) }) })
    : orig.apply(this, [req, ...a]);
};
const src = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8')
  + '\nmodule.exports.__views = [html];';
const tmp = path.join(require('os').tmpdir(), 'hamster-served-check.js');
fs.writeFileSync(tmp, src);
let bad = 0;
for (const fn of require(tmp).__views) {
  const out = fn();
  const m = /<script>\n([\s\S]*?)<\/script>/.exec(out);
  try { new Function(m[1]); } catch (e) {
    bad++;
    console.error('SERVED SCRIPT SYNTAX ERROR:', e.message);
    console.error(m[1].split('\n').filter(l => l.includes("+ '")).slice(0, 3).join('\n'));
  }
}
console.log(bad ? 'FAIL' : 'served webview scripts OK');
process.exit(bad ? 1 : 0);
