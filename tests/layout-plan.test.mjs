import test from 'node:test';
import assert from 'node:assert/strict';
import { planLayout } from '../src/layout/plan.mjs';

const context={contextId:'ctx',scopeId:'root',revisions:{structure:'s',configuration:'c',layout:'l',execution:'e'}};
const geometry={contextId:'ctx',scopeId:'root',evidenceId:'ev',sourceFrameId:'frame',layoutRevision:'l',bounds:{x:0,y:0,width:500,height:1500},nodes:[{id:'n',bounds:{x:100,y:100,width:60,height:40},position:{x:100,y:100}}],annotations:[{id:'a',bounds:{x:0,y:0,width:400,height:400}}],texts:[{id:'title',ownerId:'a',bounds:{x:30,y:800,width:300,height:40}}],connections:[{id:'wire',bendpoints:[],paths:['M10,580 C217,580 -187,1390 20,1390']}],coverage:{complete:true}};
test('plan rejects semantic changes, stale frames, unknown objects and pins',()=>{
  assert.throws(()=>planLayout({context,geometry,changes:[{kind:'annotation-text',objectId:'a',before:'a',after:'b'}]}),/kind|layout/i);
  assert.throws(()=>planLayout({context,geometry,changes:[{kind:'node-position',objectId:'missing',before:{x:0,y:0},after:{x:1,y:1}}]}),/unknown/i);
  assert.throws(()=>planLayout({context,geometry,pins:['n'],changes:[{kind:'node-position',objectId:'n',before:{x:100,y:100},after:{x:200,y:100}}]}),/pin/i);
  assert.throws(()=>planLayout({context,geometry:{...geometry,layoutRevision:'old'}}),/stale|revision/i);
});
test('local wire repair routes beyond the actual text extent and retains nodes and annotation content',()=>{
  const plan=planLayout({context,geometry,findings:[{id:'f',kind:'connection-text-intersection',severity:'error',participants:['wire','title']}],pins:['n']});
  assert.equal(plan.changes.length,1);assert.equal(plan.changes[0].kind,'connection-bendpoints');
  assert.ok(plan.changes[0].after.every(p=>p.x<=-20 || p.x>=350));
  assert.equal(plan.requiresNativeRevalidation,true);assert.equal(plan.semanticChangesAllowed,false);
});
test('explicit group containment prevents moving a member out of its annotation',()=>{
  assert.throws(()=>planLayout({context,geometry,groups:[{id:'g',nodeIds:['n'],annotationId:'a'}],changes:[{kind:'node-position',objectId:'n',before:{x:100,y:100},after:{x:500,y:100}}]}),/group/i);
});
test('measured icon bounds cannot silently stand in for exact native node coordinates',()=>{
  const measured={...geometry,nodes:[{id:'n',bounds:{x:100,y:100,width:60,height:40}}]};
  assert.throws(()=>planLayout({context,geometry:measured,changes:[{kind:'node-position',objectId:'n',before:{x:100,y:100},after:{x:200,y:100}}]}),/native|position|coordinate/i);
});
test('fractional rendered text produces an integer native position with checked clearance',()=>{
 const measured={...geometry,texts:[{id:'title',ownerId:'a',bounds:{x:90.25,y:100.33,width:100.5,height:30.34}}]};
 const plan=planLayout({context,geometry:measured,findings:[{id:'overlap',severity:'high',participants:['n','title']}]});
 assert.equal(plan.changes.length,1);const moved=plan.changes[0].after;assert.ok(Number.isInteger(moved.x)&&Number.isInteger(moved.y));assert.ok(moved.y>=143||moved.y+40<=88||moved.x>=203||moved.x+60<=78);
 assert.throws(()=>planLayout({context,geometry,changes:[{kind:'node-position',objectId:'n',before:{x:100,y:100},after:{x:101.5,y:100}}]}),/integer/i);
});
