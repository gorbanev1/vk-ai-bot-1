import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('actual successful astrology model/provider tracked after fallbacks',()=>{
 const app=readFileSync(new URL('../../src/app/botApplication.js',import.meta.url),'utf8');
 assert.match(app,/onModelSelected: rememberEffectiveModel/u);
 assert.match(app,/effectiveResponseModel = String\(selection\?\.model/u);
 assert.match(app,/effectiveResponseProvider = String\(selection\?\.provider/u);
 assert.match(app,/effectiveResponseRecovery = String\(selection\?\.recovery/u);
 assert.match(app,/\[ASTROLOGY GENERATION\]/u);
 assert.match(app,/Интерпретация: /u);
 assert.match(app,/источник: /u);
 const idx=app.indexOf('async function generateOpenAIText(options) {');
 const core=app.slice(idx,app.indexOf('function resolveAuditedTransportPolicy',idx));
 assert.match(core,/const selected = result\.credential \|\| \{\}/u);
 assert.match(core,/model: usedModel/u);
 assert.match(core,/provider: selected\.provider \|\| 'compat'/u);
 assert.match(core,/onModelSelected\?\.\(/u);
});
