/* Pure rules core. Browser and Node share this implementation. */
(function(root){
'use strict';
function validateChart(c){
 if(!c || typeof c.chartId!=='string'||!c.chartId.trim()||typeof c.audio!=='string'||!c.audio.trim()||!Number.isFinite(c.durationMs)||c.durationMs<=0||!['easy','normal','hard'].includes(c.difficulty)||!Array.isArray(c.obstacles)||!c.obstacles.length) throw Error('谱面基本字段无效');
 if(c.judgementWindowMs!==undefined&&(!Number.isFinite(c.judgementWindowMs)||c.judgementWindowMs<80||c.judgementWindowMs>250))throw Error('判定窗口无效');
 const ids=new Set(); let last=-Infinity;
 for(const o of c.obstacles){
  if(!o||typeof o.id!=='string'||!o.id.trim()||ids.has(o.id)||!['ground','overhead'].includes(o.type)||!Number.isFinite(o.hitTimeMs)||o.hitTimeMs<0||o.hitTimeMs>c.durationMs||o.hitTimeMs<=last) throw Error('障碍字段、ID、顺序或时间范围无效');
  ids.add(o.id);last=o.hitTimeMs;
 }
 return JSON.parse(JSON.stringify(c));
}
class Core{
 constructor({now=()=>performance.now(),musicTime=null,lateArrivalGraceMs=0}={}){this.now=now;this.musicTime=musicTime;this.lateArrivalGraceMs=lateArrivalGraceMs;this.listeners=new Set();this.offset=0;this.phase='ready';this.time=0;this.obstacles=[];this.character={action:'idle',untilMs:0};this.ending=null;this.sequence=new Map();this.passed=0;}
 subscribe(fn){this.listeners.add(fn);fn(this.getState());return()=>this.listeners.delete(fn);}
 emit(){const s=this.getState();for(const fn of this.listeners)fn(s);}
 getState(){return JSON.parse(JSON.stringify({phase:this.phase,playerId:'p1',sessionId:this.sessionId||null,musicTimeMs:this.time,offsetMs:this.phase==='ready'?this.offset:this.roundOffset,character:this.character,obstacles:this.obstacles,passedCount:this.passed,ending:this.ending,chartId:this.chart?.chartId||null,durationMs:this.chart?.durationMs||0,judgementWindowMs:this.chart?.judgementWindowMs??150}));}
 loadChart(c){if(['playing','paused'].includes(this.phase))throw Error('本局进行中');this.chart=validateChart(c);this.ready();}
 ready(){this.phase='ready';this.time=0;this.passed=0;this.ending=null;this.obstacles=(this.chart?.obstacles||[]).map(o=>({...o,status:'pending'}));this.character={action:'idle',untilMs:0};this.emit();}
 setCalibration(ms){if(this.phase!=='ready')throw Error('仅准备阶段可校准');if(!Number.isInteger(ms)||ms< -200||ms>400||ms%5)throw Error('校准需为 -200～400 毫秒，步长 5');this.offset=ms;this.emit();}
 start(sessionId){if(!this.chart)throw Error('请先加载谱面');if(typeof sessionId!=='string'||!sessionId.trim())throw Error('需要有效 sessionId');this.ready();this.sessionId=sessionId;this.sequence.clear();this.roundOffset=this.offset;this.anchor=this.now();this.resumeAt=this.anchor;this.base=0;this.phase='playing';this.emit();}
 readTime(){return this.musicTime?this.musicTime():this.base+this.now()-this.anchor;}
 tick(){if(this.phase!=='playing')return;this.time=Math.max(this.time,this.readTime());if(this.character.untilMs<this.time)this.character.action='idle';
  const missed=this.obstacles.find(o=>o.status==='pending'&&this.time>this.deadline(o)+this.lateArrivalGraceMs);
  if(missed){missed.status='missed';this.finish('dead','未在判定窗口内完成正确动作');return;}
  if(this.time>=this.chart.durationMs&&this.obstacles.every(o=>o.status==='passed'))this.finish('clear','音乐结束，全部障碍通过');else this.emit();
 }
 deadline(o){return o.hitTimeMs+(this.chart.judgementWindowMs??150)+Math.max(this.roundOffset,0);}
 receiveAction(a){
  if(this.phase!=='playing')return {accepted:false,reason:'not_playing'};
  const now=this.now();
  if(!a||a.sessionId!==this.sessionId||!Number.isInteger(a.sequence)||a.sequence<0||!['swing_up','swing_down'].includes(a.action)||!['phone','keyboard','simulator'].includes(a.source)||!Number.isFinite(a.receivedAtMs)||a.receivedAtMs>now||a.receivedAtMs<this.resumeAt||(a.source==='phone'&&(!Number.isFinite(a.sensorTimeMs)||a.sensorTimeMs<0)))return {accepted:false,reason:'invalid_or_stale'};
  const key=a.source+':'+(a.phoneSessionId||'');if(a.sequence<=(this.sequence.get(key)??-1))return {accepted:false,reason:'duplicate_or_out_of_order'};
  this.sequence.set(key,a.sequence);
  const currentMusicTime=Math.max(this.time,this.readTime());
  const receivedMusicTime=currentMusicTime-(now-a.receivedAtMs),effective=receivedMusicTime-this.roundOffset;
  this.character={action:a.action==='swing_up'?'jump':'crouch',untilMs:this.time+300};
  const candidates=this.obstacles.filter(o=>o.status==='pending'&&currentMusicTime<=this.deadline(o)+this.lateArrivalGraceMs&&receivedMusicTime<=this.deadline(o)&&Math.abs(effective-o.hitTimeMs)<=(this.chart.judgementWindowMs??150)&&o.type===(a.action==='swing_up'?'ground':'overhead'));
  candidates.sort((a,b)=>Math.abs(effective-a.hitTimeMs)-Math.abs(effective-b.hitTimeMs));
  const hit=candidates[0];if(hit){hit.status='passed';hit.errorMs=effective-hit.hitTimeMs;this.passed++;this.time=currentMusicTime;this.emit();return {accepted:true,matched:hit.id,errorMs:hit.errorMs};}
  this.time=currentMusicTime;this.tick();if(this.phase!=='playing')return {accepted:false,reason:'round_ended'};
  this.emit();return {accepted:true,matched:hit?.id||null,errorMs:hit?.errorMs??null};
 }
 pause(){if(this.phase!=='playing')return;this.tick();if(this.phase!=='playing')return;this.base=this.time;this.phase='paused';this.emit();}
 resume(){if(this.phase!=='paused')return;this.anchor=this.now();this.resumeAt=this.anchor;this.phase='playing';this.emit();}
 interrupt(reason='连接中断'){if(['playing','paused'].includes(this.phase))this.finish('interrupted',reason);}
 finish(kind,reason){this.phase='ended';this.character.action=kind==='dead'?'dead':'idle';this.ending={kind,reason,validScore:kind!=='interrupted',passedCount:this.passed};this.emit();}
}
const api={Core,validateChart};if(typeof module!=='undefined')module.exports=api;else root.MihayouCore=api;
})(typeof window==='undefined'?globalThis:window);
