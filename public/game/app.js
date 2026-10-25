(()=>{
'use strict';
const $=id=>document.getElementById(id),canvas=$('stage'),ctx=canvas.getContext('2d');
let audioContext,buffer,source,origin=0,held=0,seq=0,generation=0,audioReady=false,audioDuration=30000,audioName='funny-pigs.mp3',currentRunId=null,phoneConnected=false,calibration=null;
let match=null,recordedRound=false,hadSensor=false,latestOffset=null;
const icons=()=>window.lucide?.createIcons();
function buttonLabel(id,text){const button=$(id);const label=button.querySelector('span');if(label)label.textContent=text;else button.textContent=text;}
function selectedMode(){return document.querySelector('input[name="mode"]:checked').value;}
function refreshSetup(){
 const level=MihayouMatch.levels[$('difficulty').value],chart=MihayouMatch.chartFor(window.DEMO_CHART,$('difficulty').value);
 $('player-names').hidden=selectedMode()!=='versus';
 $('difficulty-detail').textContent=`${chart.obstacles.length} 个障碍 · ±${level.windowMs} ms`;
 $('chart-footer').textContent=`Funny Pigs · ${level.label} · ${chart.obstacles.length} 个障碍`;
}
function showResults(){
 $('results').hidden=!match?.results.length;
 if(!match)return;
 $('verdict').textContent=match.verdict()||(match.currentName+' 待开始');
 $('result-rows').replaceChildren();
 for(const r of match.results){
  const tr=document.createElement('tr');
  for(const value of [r.name,`${r.passed} / ${r.total}`,`${(r.survivedMs/1000).toFixed(2)} s`,r.clear?'通关':'碰撞']){
   const td=document.createElement('td');td.textContent=value;tr.append(td);
  }
  $('result-rows').append(tr);
 }
}
const core=new MihayouCore.Core({musicTime:()=>audioContext?Math.max(0,MihayouLink.toMusicTimeMs({receivedAtMs:performance.now()},audioContext,origin)):0,lateArrivalGraceMs:250});
const log=t=>{$('log').textContent=(t+'\n'+$('log').textContent).slice(0,5000);};
function halt(){if(source){source.onended=null;try{source.stop();}catch{}source.disconnect();source=null;}}
function playAt(ms){halt();origin=audioContext.currentTime-ms/1000;if(ms<buffer.duration*1000){source=audioContext.createBufferSource();source.buffer=buffer;source.connect(audioContext.destination);source.start(0,ms/1000);}}
async function decode(bytes,name){audioContext??=new AudioContext();const next=await audioContext.decodeAudioData(bytes);buffer=next;audioDuration=next.duration*1000;audioName=name;audioReady=true;}
async function start(){
 if(calibration||['playing','paused'].includes(core.phase))return;
 const ticket=++generation;
 try{
  if(!audioReady)throw Error('音频尚未加载');
  if(!currentRunId)throw Error('通信尚未连接，请先等待电脑服务在线');
  await audioContext.resume();
  if(ticket!==generation)return;
  if(!match||match.complete){
   if(latestOffset!==null)core.offset=latestOffset;
   match=new MihayouMatch.Match({mode:selectedMode(),difficulty:$('difficulty').value,names:[$('name-1').value,$('name-2').value]});
   match.offsetMs=core.offset;
   core.loadChart(MihayouMatch.chartFor(window.DEMO_CHART,match.difficulty));
  }
  if(Math.abs(audioDuration-core.chart.durationMs)>100)throw Error('音频长度与谱面不符（允许误差100ms）');
  if(audioName!==core.chart.audio)throw Error('音频与谱面不匹配：'+core.chart.audio);
  halt();held=0;seq=0;recordedRound=false;
  core.offset=match.mode==='versus'?match.offsetMs:core.offset;
  playAt(0);core.start(currentRunId);
  showResults();
  $('feedback').textContent=match.currentName+' · 开始';
 }catch(e){halt();log(e.message);$('feedback').textContent=e.message;}
}
function receiveAction(a){const result=core.receiveAction(a);if(core.phase==='ended'){log(JSON.stringify(result));return result;}$('feedback').textContent=result.accepted?(result.matched?'通过 '+result.matched+' · 偏差 '+Math.round(result.errorMs)+'ms':'动作已接收，未命中障碍'):'动作未接纳：'+result.reason;log(JSON.stringify(result));return result;}
function handleIncoming(a){
 if(calibration){
  const time=a?.receivedAtMs;
  if(a?.action!=='swing_up'||!Number.isFinite(time)||time>performance.now()||time<calibration.startedAt)return {accepted:false,reason:'calibration_ignored'};
  const key=`${a.source}:${a.phoneSessionId||''}:${a.sequence}`;
  if(calibration.seen.has(key))return {accepted:false,reason:'duplicate'};
  calibration.seen.add(key);
  calibration.actions.push(time);
  if(calibration.mode==='auto'){
   const matches=MihayouCalibration.matchBeats(calibration.expected.map(outputPerformanceTime),calibration.actions);
   $('calibration-status').textContent=`自动校准：${matches.length} / 8 拍`;
  }else{
   const nearest=calibration.expected.map(outputPerformanceTime).sort((x,y)=>Math.abs(time-x)-Math.abs(time-y))[0];
   if(Number.isFinite(nearest)&&Math.abs(time-nearest)<=450){
    calibration.lastRawError=time-nearest;
    showPracticeError();
   }
  }
  return {accepted:true,matched:null};
 }
 return receiveAction(a);
}
function local(action,source='keyboard'){return handleIncoming({sessionId:core.sessionId,sequence:++seq,action,receivedAtMs:performance.now(),source});}
core.subscribe(s=>{
 $('phase').textContent={ready:'准备',playing:'进行中',paused:'已暂停',ended:'已结束'}[s.phase];$('timer').textContent=`${(s.musicTimeMs/1000).toFixed(2)} / ${(s.durationMs/1000).toFixed(2)} s`;$('score').textContent='通过 '+s.passedCount;$('session').textContent=s.sessionId||'尚未开始';
 const competitionLocked=match?.mode==='versus'&&!match.complete;
 const setupLocked=['playing','paused'].includes(s.phase)||!!competitionLocked;
 $('mode-options').disabled=$('difficulty').disabled=$('name-1').disabled=$('name-2').disabled=setupLocked;
 $('offset').disabled=$('offset-slider').disabled=s.phase!=='ready'||calibration?.mode==='auto'||competitionLocked;
 $('auto-calibrate').disabled=$('practice').disabled=!audioReady||s.phase!=='ready'||!!calibration||competitionLocked;
 $('cancel-calibration').hidden=!calibration;
 $('start').disabled=!audioReady||!currentRunId||!phoneConnected||!!calibration||['playing','paused'].includes(s.phase);
 buttonLabel('start',s.phase==='ended'?(s.ending?.validScore?'再来一局':'重试本局'):match&&!match.complete?'开始 '+match.currentName:'开始');
 $('pause').disabled=!['playing','paused'].includes(s.phase);buttonLabel('pause',s.phase==='paused'?'继续':'暂停');$('stop').disabled=!['playing','paused'].includes(s.phase);
 if(s.ending){
  halt();
  if(!recordedRound){recordedRound=true;if(match?.record(s))showResults();}
  $('feedback').textContent=({clear:'通关！',dead:'碰撞，本局结束。',interrupted:'本局已中断，成绩无效。'}[s.ending.kind])+` 通过 ${s.passedCount} / ${s.obstacles.length}。`;
 }
 const next=s.phase==='ended'&&s.ending?.validScore&&match?.mode==='versus'&&!match.complete;
 $('next-player').hidden=!next;$('start').hidden=!!next;
 if(next)buttonLabel('next-player','交给 '+match.currentName);
 $('current-player').textContent=next?'下一位：'+match.currentName:match?match.currentName:'玩家 1';
 draw(s);
});
function draw(s){ctx.clearRect(0,0,1000,360);ctx.fillStyle='#35453b';for(let x=0;x<1000;x+=50)ctx.fillRect(x,0,1,360);ctx.fillStyle='#7a9383';ctx.fillRect(0,285,1000,2);ctx.setLineDash([6,6]);ctx.strokeStyle='#b4ff79';ctx.beginPath();ctx.moveTo(180,30);ctx.lineTo(180,300);ctx.stroke();ctx.setLineDash([]);ctx.font='15px sans-serif';ctx.fillStyle='#b4ff79';ctx.fillText('判定线',153,24);
 const speed=MihayouMatch.levels[match?.difficulty||$('difficulty').value].speed;
 for(const o of s.obstacles){const x=180+(o.hitTimeMs-s.musicTimeMs)*speed;if(x< -60||x>1060)continue;ctx.fillStyle=o.status==='passed'?'#587962':o.status==='missed'?'#f36f76':o.type==='ground'?'#f4bf7d':'#b1b6fa';const y=o.type==='ground'?235:140;ctx.fillRect(x-20,y,40,o.type==='ground'?50:65);ctx.fillText(o.type==='ground'?'↑ 跳':'↓ 蹲',x-24,y-12);}
 const a=s.character.action;ctx.fillStyle=a==='dead'?'#f36f76':'#b4ff79';ctx.fillRect(158,a==='jump'?165:a==='crouch'?255:215,44,a==='crouch'?30:70);
 ctx.fillStyle='#173021';ctx.fillRect(185,a==='jump'?178:a==='crouch'?260:228,5,5);
 ctx.fillStyle='#e9edf7';ctx.fillText({idle:'等待',jump:'跳跃',crouch:'蹲伏',dead:'碰撞'}[a],158,330);
}
$('start').onclick=start;$('pause').onclick=async()=>{if(core.phase==='playing'){core.pause();held=core.time;halt();}else if(core.phase==='paused'){const ticket=++generation;await audioContext.resume();if(ticket!==generation||core.phase!=='paused')return;playAt(held);core.resume();}};
$('stop').onclick=()=>{generation++;core.interrupt('手动结束');};
$('ready').onclick=()=>{generation++;stopCalibration();halt();match=null;recordedRound=false;showResults();if(latestOffset!==null){core.offset=latestOffset;showOffset(latestOffset);}core.loadChart(MihayouMatch.chartFor(window.DEMO_CHART,$('difficulty').value));$('feedback').textContent='准备就绪';};
$('next-player').onclick=()=>{generation++;halt();core.ready();core.setCalibration(match.offsetMs);showOffset(match.offsetMs);$('feedback').textContent='请把手机交给 '+match.currentName;};
$('difficulty').onchange=()=>{match=null;showResults();refreshSetup();core.loadChart(MihayouMatch.chartFor(window.DEMO_CHART,$('difficulty').value));};
for(const radio of document.querySelectorAll('input[name="mode"]'))radio.onchange=()=>{match=null;showResults();refreshSetup();};
$('export-score').onclick=()=>{
 if(!match?.results.length)return;
 const data={exportedAt:new Date().toISOString(),mode:match.mode,difficulty:match.difficulty,chartId:core.chart.chartId,offsetMs:match.offsetMs,verdict:match.verdict(),results:match.results};
 const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),anchor=document.createElement('a');
 anchor.href=url;anchor.download='mihayou-scores.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
 let offsetTimer=0,pendingOffset=null,offsetVersion=0;
 function showOffset(value){
  $('offset').value=$('offset-slider').value=value;
  $('offset-status').textContent=`偏移 ${value>=0?'+':''}${value} ms`;
 }
 function showPracticeError(){
  if(calibration?.mode!=='practice'||!Number.isFinite(calibration.lastRawError))return;
  const error=calibration.lastRawError-core.offset;
  $('calibration-status').textContent=`调整后${error>=0?'偏晚':'偏早'} ${Math.round(Math.abs(error))} ms`;
 }
 async function applyOffset(){
  const value=Number($('offset').value);
  try{
   core.setCalibration(value);
   latestOffset=value;
   localStorage.setItem('mihayou.offset',value);
   showOffset(value);
   showPracticeError();
   clearTimeout(offsetTimer);
   pendingOffset=value;
   const version=++offsetVersion;
   offsetTimer=setTimeout(async()=>{
    try{
     const response=await fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({offsetMs:value})});
     if(!response.ok)throw Error('电脑偏移保存失败');
     if(version===offsetVersion)$('offset-status').textContent+= ' · 已保存';
     log('判定偏移已同步：'+(value>=0?'+':'')+value+' ms');
    }catch(error){log(error.message);if(version===offsetVersion)$('offset-status').textContent+=' · 保存失败，请重试';}
    finally{if(version===offsetVersion)pendingOffset=null;}
   },120);
  }catch(e){log(e.message);showOffset(core.offset);}
 }
 $('offset').oninput=applyOffset;$('offset').onchange=applyOffset;
 $('offset-slider').oninput=()=>{$('offset').value=$('offset-slider').value;applyOffset();};
 $('offset-slider').onchange=$('offset-slider').oninput;
 function outputPerformanceTime(contextTime){
  const stamp=audioContext.getOutputTimestamp?.();
  if(stamp&&Number.isFinite(stamp.contextTime)&&Number.isFinite(stamp.performanceTime)&&stamp.performanceTime>0)
   return stamp.performanceTime+(contextTime-stamp.contextTime)*1000;
  return performance.now()+(contextTime-audioContext.currentTime)*1000;
 }
 function beepAt(contextTime,owner){
  const oscillator=audioContext.createOscillator(),gain=audioContext.createGain();
  oscillator.type='sine';oscillator.frequency.value=880;gain.gain.setValueAtTime(.0001,contextTime);
  gain.gain.exponentialRampToValueAtTime(.18,contextTime+.008);gain.gain.exponentialRampToValueAtTime(.0001,contextTime+.12);
  oscillator.connect(gain).connect(audioContext.destination);
  owner.oscillators.add(oscillator);
  oscillator.onended=()=>{owner.oscillators.delete(oscillator);oscillator.disconnect();gain.disconnect();};
  oscillator.start(contextTime);oscillator.stop(contextTime+.14);
 }
 function stopCalibration(message='校准已停止，原偏移保留'){
  const old=calibration;if(!old)return;
  calibration=null;clearTimeout(old.timer);clearInterval(old.interval);
  for(const oscillator of old.oscillators){try{oscillator.stop();}catch{}}
  $('calibration-status').textContent=message;core.emit();
 }
 async function startCalibration(mode){
  if(calibration||core.phase!=='ready'||!audioReady)return;
  const owner={mode,actions:[],expected:[],seen:new Set(),oscillators:new Set(),startedAt:performance.now()};
  calibration=owner;core.emit();
  try{
   await audioContext.resume();
   if(calibration!==owner)return;
   const startAt=audioContext.currentTime+.7;
   $('calibration-status').textContent=mode==='auto'?'自动校准：跟随 8 声节拍做上挥':'节拍试听中';
   if(mode==='practice'){
    let next=startAt;
    const schedule=()=>{
     while(next<audioContext.currentTime+.8){
      if(next>=audioContext.currentTime){owner.expected.push(next);beepAt(next,owner);}
      next+=1;
     }
     owner.expected=owner.expected.slice(-4);owner.actions=owner.actions.slice(-8);
    };
    schedule();owner.interval=setInterval(schedule,100);return;
   }
   for(let i=0;i<8;i++){owner.expected.push(startAt+i);beepAt(startAt+i,owner);}
   owner.timer=setTimeout(()=>{
    if(calibration!==owner)return;
    const result=MihayouCalibration.evaluate(owner.expected.map(outputPerformanceTime),owner.actions);
    if(!result.ok){
     const reasons={too_few:`仅匹配 ${result.count} / 8 拍，至少需要 6 拍`,unstable:'动作偏差不稳定',out_of_range:'偏移超出可调范围'};
     stopCalibration('校准未采用：'+reasons[result.reason]+'；原偏移保留');return;
    }
    const value=result.offsetMs;
    stopCalibration(`校准完成：${result.count} / 8 拍有效，建议 ${value>=0?'+':''}${value} ms`);
    $('offset').value=value;applyOffset();
    for(const match of result.matches){
     fetch('/api/calibration',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({runId:currentRunId,errorMs:match.errorMs-value,offsetMs:value,beatIndex:match.beatIndex,audioOutputTimestamp:!!audioContext.getOutputTimestamp?.()?.performanceTime})})
      .then(response=>{if(!response.ok)throw Error('校准样本保存失败');}).catch(error=>log(error.message));
    }
   },(startAt-audioContext.currentTime+7+1.1)*1000);
  }catch(error){stopCalibration('校准无法开始：'+error.message);}
 }
 $('auto-calibrate').onclick=()=>startCalibration('auto');
 $('practice').onclick=()=>startCalibration('practice');
 $('cancel-calibration').onclick=()=>stopCalibration();
for(const b of document.querySelectorAll('[data-action]'))b.onclick=()=>local(b.dataset.action,'simulator');
document.addEventListener('keydown',e=>{if(e.repeat||/INPUT|TEXTAREA|SUMMARY/.test(e.target.tagName))return;const action={ArrowUp:'swing_up',' ':'swing_up',ArrowDown:'swing_down'}[e.key];if(action){e.preventDefault();local(action);}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){stopCalibration('页面已隐藏，校准停止');if(core.phase==='playing'){$('pause').click();log('页面隐藏，自动暂停');}}});
 window.addEventListener('mihayou-link:session',e=>{const next=e.detail?.runId;if(!next)return;const changed=currentRunId&&currentRunId!==next;currentRunId=next;if(changed)stopCalibration('通信测试局已切换，校准停止');if(changed&&['playing','paused'].includes(core.phase)){generation++;halt();core.interrupt('通信测试局已切换，请重新开始');}else if(core.phase==='ready')core.emit();$('session').textContent=next;});
 window.addEventListener('mihayou-link:offset',e=>{const value=Number(e.detail?.offsetMs);if(!Number.isInteger(value)||pendingOffset!==null)return;latestOffset=value;localStorage.setItem('mihayou.offset',value);if(match?.mode==='versus'&&!match.complete){showOffset(match.offsetMs);if(value!==match.offsetMs)$('offset-status').textContent+=' · 新设置下一组生效';return;}showOffset(value);if(core.phase==='ready'){try{core.setCalibration(value);}catch{}}else{core.offset=value;$('offset-status').textContent+=' · 下一局生效';}});
 window.addEventListener('mihayou-link:connection',e=>{phoneConnected=!!e.detail?.connected;$('connection').textContent=phoneConnected?'通信已连接 · 等待手机动作':'通信断开 · 正在重连';if(!phoneConnected){stopCalibration('通信断开，校准停止');if(['playing','paused'].includes(core.phase))core.interrupt('通信连接断开');}core.emit();});
window.addEventListener('mihayou-link:phone-state',e=>{
 const sensors=e.detail?.sensorConnections||[],online=e.detail?.clients?.some(c=>c.online);
 $('phone-status').textContent=sensors.length?'MihaSensor 已连接':online?'备用控制器已连接':'等待 MihaSensor';
 if(hadSensor&&!sensors.length){
  stopCalibration('手机连接断开，校准停止');
  if(['playing','paused'].includes(core.phase))core.interrupt('手机连接断开');
 }
 hadSensor=!!sensors.length;
});
window.Mihayou=Object.freeze({receiveAction:handleIncoming,getState:()=>core.getState(),subscribe:fn=>core.subscribe(fn),start,restart:start,setCalibration:ms=>{$('offset').value=ms;return applyOffset();},loadChart:c=>core.loadChart(c),ready:()=>{$('ready').click();},interrupt:reason=>{stopCalibration();core.interrupt(reason);}});
 refreshSetup();core.loadChart(MihayouMatch.chartFor(window.DEMO_CHART,$('difficulty').value));try{const n=Number(localStorage.getItem('mihayou.offset')||0);core.setCalibration(n);showOffset(core.offset);}catch{}
 fetch('funny-pigs.mp3').then(r=>{if(!r.ok)throw Error('funny pigs 音轨读取失败');return r.arrayBuffer();}).then(b=>decode(b,'funny-pigs.mp3')).then(()=>{core.emit();log('funny pigs 普通谱面已就绪');}).catch(e=>{log(e.message);$('start').textContent='音轨加载失败';$('feedback').textContent='请通过电脑服务的 /game/ 页面打开，不要直接双击 HTML。';});
 MihayouLink.connect(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`,{allowLegacy:true,onAction:handleIncoming});
function frame(){core.tick();requestAnimationFrame(frame);}requestAnimationFrame(frame);
window.addEventListener('DOMContentLoaded',icons);
})();
