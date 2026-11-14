"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { generateSingleAgnesClip } = require("./agnes");
const { generateLtxFiveSecondShot } = require("./huggingface-ltx");
const { getVideoModelPool, getFreeHostedModelCandidates } = require("./video-model-registry");

const BEAT_GROUPS = [[0,1],[2,3],[4,5],[6,7],[8],[9]];
const BEAT_SECONDS = 10;
const EDIT_SECONDS = 6;
const TOTAL_SECONDS = 60;

function safe(value, max = 600) {
  return String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}
function buildSixBeatPrompts(scenes, topic) {
  if (!Array.isArray(scenes) || scenes.length !== 10) throw new Error("Six-beat orchestration needs the ten-scene director storyboard.");
  return BEAT_GROUPS.map((group, index) => {
    const directions = group.map((sceneIndex, part) =>
      (part ? "Then transition into: " : "Opening action: ") + safe(scenes[sceneIndex].visual_direction, 450)
    ).join(" ");
    return [
      "Create one professional cinematic vertical 9:16 live-action documentary video, exactly 10 seconds, 30fps.",
      "Story topic: " + safe(topic, 180) + ".",
      "Story beat " + (index + 1) + " of 6. " + directions,
      "Make the action physically believable and visually specific. Use a real recognizable environment, coherent people and objects, natural movement, cinematic camera motion, realistic lighting and a strong composition.",
      "This shot must visually connect to the surrounding story beats. Preserve recurring subject identity, wardrobe, props and environment where relevant.",
      "No titles, text, captions, logos, watermarks, diagrams, abstract backgrounds, slideshows or frozen frames."
    ].join(" ");
  });
}
function run(args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-1800); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error((label || "FFmpeg") + " failed: " + stderr.slice(-1000))));
  });
}
async function joinFiveSecondShots(first, second, destination) {
  const list = destination.replace(/\.mp4$/i, "-concat.txt");
  await fs.promises.writeFile(list, "file '" + first.replace(/'/g, "'\\''") + "'\nfile '" + second.replace(/'/g, "'\\''") + "'\n");
  await run(["-y","-hide_banner","-loglevel","error","-f","concat","-safe","0","-i",list,
    "-t","10","-an","-c:v","libx264","-preset","veryfast","-crf","21","-pix_fmt","yuv420p","-movflags","+faststart",destination],
    "LTX five-second shot assembly");
  await fs.promises.unlink(list).catch(()=>{});
  const stat=await fs.promises.stat(destination);
  if(stat.size<20000) throw new Error("The paired LTX shots did not produce a valid 10-second MP4.");
}
async function generateLtxBeat(prompt, workDir, beatIndex) {
  const first=path.join(workDir,"beat-"+(beatIndex+1)+"-ltx-a.mp4");
  const second=path.join(workDir,"beat-"+(beatIndex+1)+"-ltx-b.mp4");
  const output=path.join(workDir,"beat-"+(beatIndex+1)+"-ltx-10s.mp4");
  const firstPrompt=prompt+" Opening five seconds: establish the location and introduce the main subject with a clear action.";
  const secondPrompt=prompt+" Continuation five seconds: use a new complementary camera angle and continue the same action and subject identity. Do not restart the story.";
  await generateLtxFiveSecondShot(firstPrompt,first,crypto.randomInt(1,2147483647));
  await generateLtxFiveSecondShot(second,second,crypto.randomInt(1,2147483647));
  await joinFiveSecondShots(first,second,output);
  return output;
}
async function generateAgnesBeat(prompt,workDir,beatIndex,onProgress=()=>{}) {
  const output=path.join(workDir,"beat-"+(beatIndex+1)+"-agnes-10s.mp4");
  return generateSingleAgnesClip(prompt,output,10,{
    timeoutMs:8*60*1000,
    onProgress:(status,percent)=>{
      try{onProgress("Agnes status: "+(status||"processing")+" ("+(Number(percent)||0)+"%).");}catch(_){}
    }
  });
}
function isCapacityUnavailable(error) {
  return /queue.{0,30}full|full.{0,30}queue|zerogpu|zero.?gpu|capacity|http\s*(429|502|503|504)|temporarily unavailable|overloaded|timed?\s*out|timeout|rate.?limit/i
    .test(String(error&&error.message||error||""));
}
async function withProviderHeartbeat(provider,beatNumber,progress,task,onProgress) {
  const started=Date.now();
  const heartbeat=setInterval(()=>{
    const elapsed=Math.max(1,Math.round((Date.now()-started)/1000));
    const message="Beat "+beatNumber+" of 6: "+provider+" is still processing ("+elapsed+"s elapsed). YTAgent is waiting for the result or will switch provider if it times out.";
    console.log("YTAgent "+message);
    try{onProgress(progress,message);}catch(_){}
  },12000);
  if(typeof heartbeat.unref==="function") heartbeat.unref();
  try{return await task((detail)=>{
    try{onProgress(progress,"Beat "+beatNumber+" of 6: "+provider+" "+detail);}catch(_){}
  });}
  finally{clearInterval(heartbeat);}
}
async function makeSixSecondTimelineClips(beatClips,workDir) {
  const output=[];
  for(let scene=0;scene<10;scene++){
    const start=scene*EDIT_SECONDS, end=start+EDIT_SECONDS;
    let cursor=start, parts=[];
    while(cursor<end-0.0001){
      const beatIndex=Math.min(5,Math.floor(cursor/BEAT_SECONDS));
      const beatEnd=(beatIndex+1)*BEAT_SECONDS;
      const length=Math.min(end,beatEnd)-cursor;
      const localStart=cursor-beatIndex*BEAT_SECONDS;
      const part=path.join(workDir,"timeline-"+(scene+1)+"-part-"+(parts.length+1)+".mp4");
      await run(["-y","-hide_banner","-loglevel","error","-ss",localStart.toFixed(3),"-i",beatClips[beatIndex],
        "-t",length.toFixed(3),"-vf","scale=540:960:force_original_aspect_ratio=increase,crop=540:960,fps=24,setsar=1",
        "-an","-c:v","libx264","-preset","veryfast","-crf","22","-pix_fmt","yuv420p","-movflags","+faststart",part],
        "Timeline shot "+(scene+1));
      parts.push(part); cursor+=length;
    }
    const destination=path.join(workDir,"multi-provider-scene-"+String(scene+1).padStart(2,"0")+".mp4");
    if(parts.length===1) await fs.promises.copyFile(parts[0],destination);
    else {
      const list=path.join(workDir,"timeline-"+(scene+1)+"-concat.txt");
      await fs.promises.writeFile(list,parts.map(file=>"file '"+file.replace(/'/g,"'\\''")+"'").join("\n")+"\n");
      await run(["-y","-hide_banner","-loglevel","error","-f","concat","-safe","0","-i",list,"-c","copy","-movflags","+faststart",destination],"Timeline segment join");
    }
    const stat=await fs.promises.stat(destination);
    if(stat.size<12000) throw new Error("Timeline scene "+(scene+1)+" failed its MP4 check.");
    output.push(destination);
  }
  return output;
}
async function generateMultiProviderTimelineClips(scenes,topic,workDir,onProgress=()=>{}) {
  if(!ffmpegPath) throw new Error("FFmpeg is unavailable for multi-provider assembly.");
  const prompts=buildSixBeatPrompts(scenes,topic);
  const agnesEnabled=Boolean(process.env.AGNES_API_KEY) &&
    ["true","1","yes","confirmed","on"].includes(String(process.env.AGNES_FREE_QUOTA_CONFIRMED||"").trim().toLowerCase());
  const ltxEnabled=String(process.env.HF_LTX_ENABLED||"true").trim().toLowerCase()!=="false";
  if(!agnesEnabled&&!ltxEnabled) throw new Error("No confirmed free cinematic video providers are enabled.");
  const beatClips=[],usedProviders=new Set(),disabledProviders=new Set();
  for(let i=0;i<6;i++){
    try{onProgress(7+Math.round(i*2),"Preparing professional story beat "+(i+1)+" of 6 and selecting an available video AI.");}catch(_){}
    const preferAgnes=(i%2===0);
    const providers=(preferAgnes?["Agnes","LTX"]:["LTX","Agnes"]).filter(name=>(name==="Agnes"?agnesEnabled:ltxEnabled)&&!disabledProviders.has(name));
    const failures=[];
    let completed=false;
    for(const provider of providers){
      try{
        const progress=7+Math.round(i*2);
        const clip=await withProviderHeartbeat(provider,i+1,progress,
          provider==="Agnes"
            ? detail=>generateAgnesBeat(prompts[i],workDir,i,detail)
            : async detail=>generateLtxBeat(prompts[i],workDir,i),
          onProgress);
        beatClips.push(clip);usedProviders.add(provider);completed=true;
        try{onProgress(10+Math.round((i+1)*8),"Generated story beat "+(i+1)+" of 6 with "+provider+".");}catch(_){}
        break;
      }catch(error){
        failures.push(provider+": "+safe(error.message||error,220));
        if(isCapacityUnavailable(error)) {
          disabledProviders.add(provider);
          console.warn("YTAgent disabling "+provider+" for the rest of this film after a capacity/timeout failure.");
        }
        console.warn("YTAgent beat "+(i+1)+" provider "+provider+" failed:",error.message||error);
      }
    }
    if(!completed) throw new Error("Story beat "+(i+1)+" failed on every available provider. "+failures.join(" | "));
  }
  try{onProgress(62,"Joining six ten-second story beats into the ten-shot editing timeline.");}catch(_){}
  const clips=await makeSixSecondTimelineClips(beatClips,workDir);
  return {
    clips,
    provider:"Six-beat multi-provider pipeline ("+Array.from(usedProviders).join(" + ")+")",
    beatClips,
    providers:Array.from(usedProviders),
    modelPoolCount:getVideoModelPool().length,
    eligibleFreeHostedCandidates:getFreeHostedModelCandidates().map(item=>item.id)
  };
}
module.exports={BEAT_GROUPS,buildSixBeatPrompts,makeSixSecondTimelineClips,generateMultiProviderTimelineClips,isCapacityUnavailable};
