import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { parseChatCommand, validateRoomId } from '../lib/engines/chat-command.js';
import { runGit, commitOnCollabBranch, getRepoMetadata, getDiff, stageAndCommit, fetchCollabBranch, mergeCollabBranch } from '../lib/engines/git-engine.js';
import { BravePlayer, extractSearchResults } from '../lib/engines/brave-player.js';
import { LanDiscoveryEngine } from '../lib/engines/lan-discovery.js';
import { apply } from '../index.js';
import { packageProjectToBuffer } from '../lib/engines/publisher.js';

test('strict pure commands and namespace validation', () => {
  assert.deepEqual(parseChatCommand('/commit fix text; $(no-shell)'), { kind: 'commit', message: 'fix text; $(no-shell)' });
  assert.deepEqual(parseChatCommand('/diff'), { kind: 'diff' });
  assert.deepEqual(parseChatCommand('/share-repo'), { kind: 'repo' });
  for (const text of ['/diff x', '/commit ', '/sync @alice', '/diff\n', ' /diff']) assert.throws(() => parseChatCommand(text));
  assert.equal(validateRoomId('channel:general-dev'), 'channel:general-dev');
  for (const id of ['channel:Bad', '__proto__', '../x', 'channel:']) assert.throws(() => validateRoomId(id));
});

test('real Git collaboration commit preserves branches and rejects unsafe refs/staged secrets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-v4-git-'));
  try {
    for (const args of [['init','-b','main'], ['config','user.email','test@local'], ['config','user.name','Test']]) assert.equal((await runGit(args, dir)).ok, true);
    await fs.writeFile(path.join(dir, 'app.txt'), 'initial\n');
    await stageAndCommit(dir, { message: 'initial' });
    const before = (await getRepoMetadata(dir)).commitHash;
    await fs.writeFile(path.join(dir, 'app.txt'), 'new\n');
    const commit = await commitOnCollabBranch(dir, 'Alice', 'literal; $(no-shell)');
    assert.equal(commit.branch, 'collab/alice');
    assert.equal((await runGit(['rev-parse','main'], dir)).stdout, before);
    assert.notEqual(commit.hash, before);
    assert.equal((await getRepoMetadata(dir)).branch, 'collab/alice');
    await fs.writeFile(path.join(dir, 'space name.txt'), 'space-safe\n');
    await stageAndCommit(dir, { message: 'spaces work' });
    assert.equal((await getRepoMetadata(dir)).diffSummary.files, 0);
    await runGit(['switch','main'], dir);
    await fs.writeFile(path.join(dir,'app.txt'), 'preserved\n');
    await assert.rejects(commitOnCollabBranch(dir, 'Alice', 'refuse'), /already exists/);
    assert.equal(await fs.readFile(path.join(dir,'app.txt'),'utf8'), 'preserved\n');
    await fs.writeFile(path.join(dir,'.env'), 'secret=yes');
    await runGit(['add','.env'], dir);
    await assert.rejects(stageAndCommit(dir, {message:'blocked'}), /Shield/);
    await assert.rejects(getDiff(dir,'--output=evil'), /Invalid Git ref/);
    await assert.rejects(fetchCollabBranch(dir, {username:'a',token:'x',vaultOwner:'o',vaultRepo:'r',peerUsername:'../../evil'}), /Invalid collaboration/);
    await assert.rejects(mergeCollabBranch(dir,'--evil'), /Invalid collaboration/);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('paired HTTP channels deliver with secret auth and DMs never fan out to third parties', async () => {
  const received = [[],[],[]];
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'work-v4-transfer-'));
  const source = path.join(temp, 'source'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'hello.txt'), 'real transfer');
  const engines = ['WK-A','WK-B','WK-C'].map((machineToken,i) => new LanDiscoveryEngine({machineToken,machineName:machineToken,defaultParent:temp,onPeerMessage: m => { if(m.type==='chat') received[i].push(m.message); }}));
  try {
    for (const e of engines) await e.startHttpServer();
    const [a,b,c] = engines;
    await a.pairDirect(`127.0.0.1:${b.httpPort}`,b.currentPin);
    await a.pairDirect(`127.0.0.1:${c.httpPort}`,c.currentPin);
    const chat = {id:'m1',roomId:'channel:dev',sender:'WK-A',content:'paired only'};
    const unauth = await fetch(`http://127.0.0.1:${b.httpPort}/p2p/chat`,{method:'POST',headers:{'Content-Type':'application/json','X-Machine-Token':'WK-A'},body:JSON.stringify(chat)});
    assert.equal(unauth.status,401);
    assert.equal(received[1].length,0);
    const fanout = await a.sendChatToPeers(chat);
    assert.equal(fanout.length,2); assert.ok(fanout.every(d=>d.ok));
    assert.equal(received[1][0].roomId,'channel:dev');
    const dm = await a.sendChatToPeers({...chat,id:'dm',roomId:'dm-WK-A--WK-B'});
    assert.equal(dm.length,1); assert.equal(dm[0].token,'WK-B');
    assert.equal(received[2].length,1);
    assert.equal((await b.sendChatToPeers({...chat,id:'reply',sender:'WK-B'}))[0].ok,true);
    const forged = await fetch(`http://127.0.0.1:${b.httpPort}/p2p/chat`,{method:'POST',headers:{'Content-Type':'application/json','X-Machine-Token':'WK-A','X-Pair-Secret':a.pairSecrets.get('WK-B')},body:JSON.stringify({...chat,sender:'WK-C'})});
    assert.equal(forged.status,400);
    const archive = await packageProjectToBuffer(source, {sanitize:true,bundle:false});
    const transfer = await a.streamRepoToPeer('WK-B', 'received', archive.zipBuffer);
    assert.equal(transfer.ok, true);
    assert.equal(await fs.readFile(path.join(transfer.targetDir,'hello.txt'),'utf8'), 'real transfer');
  } finally { for(const e of engines) await e.stop(); await fs.rm(temp,{recursive:true,force:true}); }
});

test('lockup fixture extracts nested badges and filters playlist cards, legacy renderer remains', () => {
  const lockup = {contentId:'abcdefghijk',contentType:'LOCKUP_CONTENT_TYPE_VIDEO',metadata:{lockupMetadataViewModel:{title:{content:'Modern title'},metadata:{contentMetadataViewModel:{metadataRows:[{metadataParts:[{text:{content:'Artist'}}]}]}}}},contentImage:{thumbnailViewModel:{overlays:[{thumbnailOverlayBadgeViewModel:{thumbnailBadges:[{thumbnailBadgeViewModel:{text:'LIVE'}}]}}]}}};
  const data={contents:{sectionListRenderer:{contents:[{itemSectionRenderer:{contents:[{lockupViewModel:lockup},{lockupViewModel:{...lockup,contentId:'PLnotvideo',contentType:'LOCKUP_CONTENT_TYPE_PLAYLIST'}},{videoRenderer:{videoId:'12345678901',title:{runs:[{text:'Legacy'}]},lengthText:{simpleText:'2:03'}}}]}}]}}};
  const results=extractSearchResults(data);
  assert.equal(results.length,2); assert.equal(results[0].duration,'LIVE'); assert.equal(results[0].author,'Artist'); assert.equal(results[1].duration,'2:03');
});

test('Brave serializes finite live time and never overlaps polling', async () => {
  const p = new BravePlayer(); p.connection={};
  p.evaluate = async expression => vm.runInNewContext(expression, {URL,location:{href:'https://www.youtube.com/watch?v=abcdefghijk'},document:{querySelector: q=>q==='video'?{duration:Infinity,currentTime:Infinity,volume:NaN,paused:false}:null,querySelectorAll:()=>[],getElementById:()=>({getVideoData:()=>({isLive:true}),getPlayerState:()=>1}),title:'Live - YouTube'}});
  const state=await p.readState(); assert.equal(state.duration,0); assert.equal(state.currentTime,0); assert.equal(state.volume,1); assert.equal(state.audioBands,null); assert.equal(state.isLive,true);
  let active=0, max=0, calls=0;
  p.readState=async()=>{calls++;active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,1200));active--;return state;};
  p.startPolling(); await new Promise(r=>setTimeout(r,3250)); clearInterval(p.pollTimer);p.pollTimer=null;
  assert.equal(max,1);assert.ok(calls >= 2 && calls <= 3, `Expected serialized watchdog polls, got ${calls}`);
});

test('execute command route registered and channel fetch works without GitHub mapping', async () => {
  const routes=new Map(), disposers=[];
  apply({on:(event,fn)=>{if(event==='dispose')disposers.push(fn);},connection:{fetch:{register:route=>routes.set(route.path,route)}}});
  const rpc=async(action,args)=> (await (await routes.get(`/api/work/${action}`).fetch(new Request(`http://localhost/api/work/${action}`,{method:'POST',body:JSON.stringify({type:'client-request',rpcId:'v4',method:`work/${action}`,payload:{args}})}))).json()).result;
  try {
    assert.ok(routes.has('/api/work/executeChatCommand'));
    assert.deepEqual(await rpc('getChatMessages',{roomId:'channel:test-v4-empty'}),{ok:true,value:[]});
    assert.equal((await rpc('getChatMessages',{roomId:'__proto__'})).ok,false);
    assert.equal((await rpc('executeChatCommand',{text:'/diff x'})).ok,false);
    const sync=await rpc('executeChatCommand',{repoDir:process.cwd(),text:'/sync @alice'});
    assert.equal(sync.ok,false); assert.ok(sync.error.message);
  } finally { for(const fn of disposers) await fn(); }
});
