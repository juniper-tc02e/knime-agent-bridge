import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {seedModernUi} from '../scripts/launch.mjs';
test('private launcher configuration selects the required modern UI and preserves other settings',async t=>{
 const config=await fs.mkdtemp(path.join(os.tmpdir(),'knime-modern-test-'));
 t.after(()=>fs.rm(config,{recursive:true,force:true}));
 await fs.mkdir(path.join(config,'.settings'));
 const file=path.join(config,'.settings','org.knime.ui.java.prefs');
 await fs.writeFile(file,'eclipse.preferences.version=1\nstartWithWebUI=false\nexamplePreference=keep\n');
 await seedModernUi(config);
 const actual=await fs.readFile(file,'utf8');
 assert.match(actual,/^startWithWebUI=true$/m);
 assert.match(actual,/^examplePreference=keep$/m);
 await seedModernUi(config);
 assert.equal(await fs.readFile(file,'utf8'),actual);
});
