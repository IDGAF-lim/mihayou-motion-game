/* Cat assets and scene adapted from the original 0.6.0 visual module. */
(()=>{
'use strict';
const ANIMS={run:[0,1,2,3,4,5,6,7,8,9,10],jump:[11,12],crouch:[13,14,15],idle:[16,17]};
function loadImage(src){
 return new Promise((resolve,reject)=>{
  const image=new Image();
  image.onload=()=>resolve(image);
  image.onerror=()=>reject(Error('猫猫素材加载失败：'+src));
  image.src=src;
 });
}
function removeBorderWhite(image){
 const canvas=document.createElement('canvas');
 canvas.width=image.width;canvas.height=image.height;
 const ctx=canvas.getContext('2d',{willReadFrequently:true});
 ctx.drawImage(image,0,0);
 const {width:w,height:h}=canvas,pixels=ctx.getImageData(0,0,w,h),data=pixels.data;
 const visited=new Uint8Array(w*h),queue=[];
 const push=index=>{if(!visited[index]){visited[index]=1;queue.push(index);}};
 for(let x=0;x<w;x++){push(x);push((h-1)*w+x);}
 for(let y=1;y<h-1;y++){push(y*w);push(y*w+w-1);}
 // Remove only border-connected white, preserving enclosed white eyes.
 while(queue.length){
  const index=queue.pop(),p=index*4;
  if(data[p+3]>=8&&(data[p]<225||data[p+1]<225||data[p+2]<225))continue;
  data[p]=data[p+1]=data[p+2]=data[p+3]=0;
  const x=index%w,y=Math.floor(index/w);
  if(x>0)push(index-1);
  if(x<w-1)push(index+1);
  if(y>0)push(index-w);
  if(y<h-1)push(index+w);
 }
 ctx.putImageData(pixels,0,0);
 return canvas;
}
function alphaMeta(canvas){
 const {width:w,height:h}=canvas,data=canvas.getContext('2d').getImageData(0,0,w,h).data;
 let minX=w,minY=h,maxX=-1,maxY=-1;
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  if(data[(y*w+x)*4+3]<=16)continue;
  minX=Math.min(minX,x);minY=Math.min(minY,y);
  maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);
 }
 if(maxX<0)throw Error('猫猫素材内容为空');
 const sh=maxY-minY+1,band=Math.max(2,Math.round(sh*.12));
 let sumX=0,count=0;
 for(let y=Math.max(minY,maxY-band+1);y<=maxY;y++)for(let x=minX;x<=maxX;x++){
  if(data[(y*w+x)*4+3]>16){sumX+=x+.5;count++;}
 }
 return {sx:minX,sy:minY,sw:maxX-minX+1,sh,footX:sumX/count};
}
class Scene{
 constructor(canvas){
  this.canvas=canvas;this.ctx=canvas.getContext('2d');
  this.frames=[];this.boxes={};this.loaded=false;
  this.animation='idle';this.animationTime=0;this.lastTime=null;this.state=null;
 }
 async load(){
  const images=await Promise.all(Array.from({length:18},(_,i)=>loadImage(`cat${i}.png`)));
  const frames=images.map(removeBorderWhite),metas=frames.map(alphaMeta);
  for(const [name,indexes] of Object.entries(ANIMS)){
   const group=indexes.map(i=>metas[i]);
   const sx=Math.min(...group.map(m=>m.sx)),sy=Math.min(...group.map(m=>m.sy));
   this.boxes[name]={sx,sy,sw:Math.max(...group.map(m=>m.sx+m.sw))-sx,
    sh:Math.max(...group.map(m=>m.sy+m.sh))-sy,footX:group.reduce((sum,m)=>sum+m.footX,0)/group.length};
  }
  this.scale=80/this.boxes.idle.sh;
  this.runScaleFix=this.boxes.idle.sh/this.boxes.run.sh*.9;
  this.frames=frames;this.loaded=true;
 }
 setState(state,speed){this.state=state;this.speed=speed;}
 render(now){
  const state=this.state;if(!state)return;
  const dt=this.lastTime===null?0:Math.max(0,Math.min((now-this.lastTime)/1000,.1));
  this.lastTime=now;
  const action=state.character.action;
  const animation=['playing','paused'].includes(state.phase)?
   (['jump','crouch'].includes(action)?action:'run'):'idle';
  if(animation!==this.animation){this.animation=animation;this.animationTime=0;}
  if(state.phase!=='paused'&&action!=='dead')this.animationTime+=dt;
  const list=ANIMS[animation],fps=animation==='run'?15:animation==='crouch'?10:4;
  const frame=animation==='jump'?(this.animationTime<.15?11:12):list[Math.floor(this.animationTime*fps)%list.length];
  this.drawStage(state);
  if(this.loaded)this.drawCat(frame,190,285-(animation==='jump'?50:0),action==='dead');
  else{
   this.ctx.fillStyle='#e0e0ff';this.ctx.font='16px "Microsoft YaHei", sans-serif';
   this.ctx.fillText(this.error||'猫猫加载中…',24,330);
  }
 }
 drawCat(frame,x,footY,dead){
  const ctx=this.ctx,box=this.boxes[this.animation];
  const scale=this.scale*(this.animation==='run'?this.runScaleFix:1);
  ctx.save();
  if(this.animation==='run'){
   ctx.strokeStyle='rgba(0,210,255,.4)';ctx.lineWidth=2;ctx.lineCap='round';
   for(let i=0;i<2;i++){
    const lx=x-20-i*15,ly=footY-20-i*15;
    ctx.beginPath();ctx.moveTo(lx,ly);ctx.lineTo(lx-20-i*10,ly);ctx.stroke();
   }
  }
  ctx.translate(x,footY);ctx.rotate(this.animation==='run'?-.05:0);
  ctx.shadowBlur=8;ctx.shadowColor=dead?'#f36f76':'rgba(255,255,255,.7)';
  ctx.imageSmoothingEnabled=false;
  ctx.drawImage(this.frames[frame],box.sx,box.sy,box.sw,box.sh,
   -(box.footX-box.sx)*scale,-box.sh*scale,box.sw*scale,box.sh*scale);
  ctx.restore();
 }
 drawStage(state){
  const ctx=this.ctx,time=state.musicTimeMs;
  const bg=ctx.createLinearGradient(0,0,0,360);
  bg.addColorStop(0,'#05070a');bg.addColorStop(1,'#0f1524');
  ctx.fillStyle=bg;ctx.fillRect(0,0,1000,360);
  const horizon=ctx.createLinearGradient(0,285,0,360);
  horizon.addColorStop(0,'rgba(0,210,255,.15)');horizon.addColorStop(1,'rgba(0,210,255,0)');
  ctx.fillStyle=horizon;ctx.fillRect(0,285,1000,75);
  for(let i=0;i<60;i++){
   const h=Math.abs(Math.sin(time*.002+i*.6))*40+10;
   let x=(i*20-time*.15)%1200;if(x< -20)x+=1200;
   ctx.fillStyle='rgba(0,210,255,.2)';ctx.fillRect(x,285-h,8,h);
   ctx.fillStyle='rgba(255,255,255,.6)';ctx.fillRect(x,285-h,8,2);
  }
  ctx.save();ctx.shadowBlur=10;
  for(let i=0;i<6;i++){
   ctx.fillStyle=i%2===0?'#ff0055':'#00d2ff';ctx.shadowColor=ctx.fillStyle;
   const x=((i*180-time*.15)%1000+1000)%1000,y=50+(i*41)%180;
   ctx.beginPath();ctx.arc(x,y,2.5,0,Math.PI*2);ctx.fill();
  }
  ctx.restore();
  ctx.fillStyle='rgba(0,210,255,.6)';ctx.fillRect(0,285,1000,1);
  ctx.fillStyle='rgba(180,255,121,.15)';ctx.fillRect(170,30,10,270);
  ctx.strokeStyle='#b4ff79';ctx.lineWidth=1;ctx.strokeRect(170,30,10,270);
  ctx.font='bold 12px sans-serif';ctx.fillStyle='#b4ff79';ctx.fillText('START',160,20);
  for(const obstacle of state.obstacles){
   const x=180+(obstacle.hitTimeMs-time)*this.speed;
   if(x< -60||x>1060)continue;
   ctx.save();
   const color=obstacle.status==='passed'?'#587962':obstacle.status==='missed'?'#f36f76':
    obstacle.type==='ground'?'#00d2ff':'#ff0055';
   ctx.fillStyle=color;ctx.shadowBlur=obstacle.status==='pending'?15:0;ctx.shadowColor=color;
   if(obstacle.type==='ground'){
    ctx.beginPath();ctx.moveTo(x-20,285);ctx.lineTo(x+20,285);ctx.lineTo(x,235);ctx.closePath();ctx.fill();
    ctx.fillStyle='rgba(255,255,255,.4)';
    ctx.beginPath();ctx.moveTo(x,285);ctx.lineTo(x+20,285);ctx.lineTo(x,235);ctx.closePath();ctx.fill();
   }else{
    ctx.fillStyle='rgba(255,255,255,.2)';ctx.fillRect(x-2,0,4,170);
    ctx.fillStyle=color;ctx.fillRect(x-20,170,40,65);
    ctx.fillStyle='rgba(255,255,255,.7)';
    for(const y of [185,202,219])ctx.fillRect(x-20,y,40,2);
   }
   ctx.restore();
   ctx.fillStyle='#e9edf7';ctx.font='bold 14px "Microsoft YaHei", sans-serif';ctx.textAlign='center';
   ctx.fillText(obstacle.type==='ground'?'↑ 跳':'↓ 蹲',x,obstacle.type==='ground'?315:150);
   ctx.textAlign='left';
  }
 }
}
window.MihayouCatScene=Object.freeze({Scene});
})();
