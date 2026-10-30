const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { stripTypeScriptTypes } = require('node:module');
const context = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(fs.readFileSync('web/src/focusAudio.ts','utf8').replace(/^export /gm,''))+'\nthis.create=createFocusAudioPolicy;',context);
let enabled=true,focused=true;
const policy=context.create(()=>enabled,()=>focused);
class Audio {
  state='running'; handlers=[]; pauses=0; resumes=0;
  addEventListener(_,fn){this.handlers.push(fn);}
  signal(){for(const fn of this.handlers)fn();}
  async suspend(){++this.pauses;this.state='suspended';this.signal();}
  async resume(){++this.resumes;this.state='running';this.signal();}
}
const settle=async()=>{for(let i=0;i<15;++i)await Promise.resolve();};
(async()=>{
  const game=new Audio(),blocked=new Audio();blocked.state='suspended';
  policy.register(game);policy.register(blocked);await settle();assert.equal(game.pauses,0);
  focused=false;policy.sync();await settle();assert.equal(game.state,'suspended');assert.equal(game.pauses,1);
  focused=true;policy.sync();await settle();assert.equal(game.state,'running');assert.equal(game.resumes,1);assert.equal(blocked.resumes,0);
  focused=false;policy.sync();await settle();enabled=false;policy.sync();await settle();assert.equal(game.state,'running');
  enabled=true;policy.sync();await settle();game.state='running';game.signal();await settle();assert.equal(game.state,'suspended','worker auto-resume cannot defeat background pause');
  let release;const slow=new Audio();slow.suspend=()=>new Promise(resolve=>{release=()=>{slow.state='suspended';slow.signal();resolve();};});
  policy.register(slow);focused=true;policy.sync();release();await settle();assert.equal(slow.state,'running','fast refocus during pending suspension is reconciled');
  console.log('Actual focus audio policy: enabled default, blur/focus, user-owned suspension, disable, background auto-resume and pending-operation races passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
