const assert=require('node:assert/strict'), fs=require('node:fs'),vm=require('node:vm');
const{stripTypeScriptTypes}=require('node:module');
const store=new Map();
function load(){
 const context=vm.createContext({localStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)}});
 for(const name of ['offlinePolicy','nativeNotices'])vm.runInContext(stripTypeScriptTypes(fs.readFileSync(`web/src/${name}.ts`,'utf8').replace(/^export /gm,'')),context);
 return context;
}
const first=load();first.assertOfflinePlaybackAllowed();first.setOfflinePlaybackAllowed(false);
assert.throws(()=>first.assertOfflinePlaybackAllowed(),/disabled by this server/);
const reload=load();assert.throws(()=>reload.assertOfflinePlaybackAllowed(),/disabled/);
reload.setOfflinePlaybackAllowed(true);reload.assertOfflinePlaybackAllowed();
reload.markBootedOffline(true);reload.markBootedOffline(true);
assert.equal(reload.nativeNoticeCount(),1);assert.equal(reload.nativeNoticeMainMenuOnly(),1);
assert.match(reload.peekNativeNotice(),/Unable to connect/);reload.dismissNativeNotice();reload.markBootedOffline(true);assert.equal(reload.nativeNoticeCount(),0);
const shell=fs.readFileSync('engine/chocolate-doom3-bfg/neo/d3xp/menus/MenuHandler_Shell.cpp','utf8');
assert.match(shell,/!inGame && activeScreen == SHELL_AREA_ROOT && nextScreen == SHELL_AREA_ROOT && !showingIntro/);
console.log('Actual offline policy: allowed default, last-known disabled policy across reloads, re-enable, and one main-menu-only offline notice per boot passed.');
