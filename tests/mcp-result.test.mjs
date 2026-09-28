import test from 'node:test';
import assert from 'node:assert/strict';
import {withImages,structuredResult} from '../src/mcp-result.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=','base64');
test('actual MCP image blocks accompany metadata without duplicating binary data',()=>{
 const r=structuredResult(withImages({evidenceId:'frame1'},[{data:png,mimeType:'image/png'}]));
 assert.equal(r.content[1].type,'image');
 assert.equal(r.content[1].data,png.toString('base64'));
 assert.deepEqual(r.structuredContent,{evidenceId:'frame1'});
 assert.equal(JSON.stringify(r.structuredContent).includes('iVBOR'),false);
});
test('MCP image formatter refuses malformed images and oversized payloads',()=>{
 assert.throws(()=>structuredResult(withImages({},[{data:Buffer.from('not png'),mimeType:'image/png'}])),/PNG/);
 assert.throws(()=>structuredResult(withImages({},[{data:Buffer.alloc(5*1024*1024),mimeType:'image/png'}])),/budget|size/i);
});
test('errors retain the structured envelope with no attached images',()=>{
 const r=structuredResult({error:{code:'CONTEXT_CHANGED'}},true);
 assert.equal(r.isError,true);assert.equal(r.content.length,1);
});
