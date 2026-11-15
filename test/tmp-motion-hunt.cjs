// TEMP (flake hunt, removed before merge): runs the smoke test only up to the motion checks.
const fs = require('fs'), path = require('path');
let s = fs.readFileSync(path.join(__dirname, 'smoke.cjs'), 'utf8');
const marker = "check(true, 'a toast shows and then removes itself');";
s = s.slice(0, s.indexOf(marker) + marker.length) +
  "\n  } catch (e) { check(false, 'ERR ' + e.message.split('\\n')[0]); }\n  await browser.close(); server.close(); process.exit(failed ? 1 : 0);\n})();\n";
s = s.replace(/\.\.\/scripts\/serve\.mjs/, path.join(__dirname, '..', 'scripts', 'serve.mjs').replace(/\\/g, '/'));
require('module').prototype._compile.call(Object.assign(new (require('module'))(__filename), { filename: __filename, paths: module.paths }), s, __filename);
