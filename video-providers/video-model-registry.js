"use strict";

// Thirty distinct video-generation model candidates. A model entry is not a promise
// of a free hosted API. Only entries with access:"free_public" may be called as
// hosted services without a paid key. "self_hosted" requires GPU compute.
const VIDEO_MODEL_POOL = [
  {id:"wan21-t2v-1.3b",name:"Wan 2.1 T2V 1.3B",model:"Wan-AI/Wan2.1-T2V-1.3B-Diffusers",task:"text-to-video",access:"self_hosted",runtime:"kaggle",freeHosted:false},
  {id:"wan21-t2v-14b",name:"Wan 2.1 T2V 14B",model:"Wan-AI/Wan2.1-T2V-14B",task:"text-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"wan22-t2v-a14b",name:"Wan 2.2 T2V A14B",model:"Wan-AI/Wan2.2-T2V-A14B",task:"text-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"wan22-ti2v-5b",name:"Wan 2.2 TI2V 5B",model:"Wan-AI/Wan2.2-TI2V-5B",task:"text-and-image-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"wan22-i2v-a14b",name:"Wan 2.2 I2V A14B",model:"Wan-AI/Wan2.2-I2V-A14B",task:"image-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"ltx098-13b",name:"LTX-Video 0.9.8 13B Distilled",model:"Lightricks/LTX-Video",task:"text-to-video",access:"free_public",runtime:"huggingface-space",freeHosted:true,provider:"ltx-space"},
  {id:"ltx23",name:"LTX-2.3",model:"Lightricks/LTX-2.3",task:"text-and-image-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"hunyuan15",name:"HunyuanVideo 1.5",model:"tencent/HunyuanVideo-1.5",task:"text-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"hunyuan10",name:"HunyuanVideo 1.0",model:"tencent/HunyuanVideo",task:"text-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"cogvideox-2b",name:"CogVideoX 2B",model:"THUDM/CogVideoX-2b",task:"text-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"cogvideox-5b",name:"CogVideoX 5B",model:"THUDM/CogVideoX-5b",task:"text-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"mochi-1",name:"Mochi 1 Preview",model:"genmo/mochi-1-preview",task:"text-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"opensora-1.2",name:"Open-Sora 1.2",model:"hpcaitech/Open-Sora",task:"text-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"opensora-2",name:"Open-Sora 2.0",model:"hpcai-tech/Open-Sora",task:"text-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"pyramid-flow",name:"Pyramid Flow",model:"rain1011/pyramid-flow",task:"text-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"svd-xt",name:"Stable Video Diffusion XT",model:"stabilityai/stable-video-diffusion-img2vid-xt",task:"image-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"svd-1.1",name:"Stable Video Diffusion 1.1",model:"stabilityai/stable-video-diffusion-img2vid",task:"image-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"animatediff-sd15",name:"AnimateDiff SD 1.5",model:"guoyww/animatediff",task:"text-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"animatediff-sdxl",name:"AnimateDiff SDXL",model:"guoyww/AnimateDiff",task:"text-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"videocrafter2",name:"VideoCrafter2",model:"AILab-CVC/VideoCrafter2",task:"text-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"modelscope-t2v",name:"ModelScope Text-to-Video",model:"damo-vilab/text-to-video-ms-1.7b",task:"text-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"i2vgen-xl",name:"I2VGen-XL",model:"ali-vilab/i2vgen-xl",task:"image-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"dynamiCrafter",name:"DynamiCrafter",model:"Doubiiu/DynamiCrafter",task:"image-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"consisid",name:"ConsisID",model:"BestWishYsh/ConsisID",task:"image-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"skyreels-v1",name:"SkyReels V1",model:"Skywork/SkyReels-V1",task:"text-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"skyreels-v2",name:"SkyReels V2",model:"Skywork/SkyReels-V2",task:"text-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"skyreels-v3",name:"SkyReels V3",model:"Skywork/SkyReels-V3",task:"image-and-video-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"magi-1",name:"MAGI-1",model:"SandAI/MAGI-1",task:"text-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"stepvideo-t2v",name:"Step-Video-T2V",model:"stepfun-ai/Step-Video-T2V",task:"text-to-video",access:"self_hosted",runtime:"gpu",freeHosted:false},
  {id:"cosmos-predict2",name:"NVIDIA Cosmos Predict 2.5",model:"nvidia/Cosmos-Predict2.5-2B",task:"video-generation-and-world-prediction",access:"self_hosted",runtime:"gpu",freeHosted:false}
];

const FREE_HOSTED_INTEGRATIONS = [
  {id:"agnes-video-2.5-flash",name:"Agnes Video 2.5 Flash",access:"free_quota_conditional",runtime:"agnes-api",enabledBy:"AGNES_API_KEY + AGNES_FREE_QUOTA_CONFIRMED"},
  {id:"ltx-video-distilled",name:"LTX Video Distilled Space",access:"free_public_shared_queue",runtime:"huggingface-space",enabledBy:"HF_LTX_ENABLED"}
];

function getVideoModelPool() {
  return VIDEO_MODEL_POOL.map(item => ({...item}));
}
function getFreeHostedModelCandidates({allowConditionalQuota = true} = {}) {
  const models = VIDEO_MODEL_POOL.filter(item => item.access === "free_public");
  const integrations = allowConditionalQuota ? FREE_HOSTED_INTEGRATIONS : FREE_HOSTED_INTEGRATIONS.filter(item => item.access === "free_public_shared_queue");
  return [...models, ...integrations].map(item => ({...item}));
}
function getSelfHostedModels() {
  return VIDEO_MODEL_POOL.filter(item => item.access === "self_hosted").map(item => ({...item}));
}

module.exports = {VIDEO_MODEL_POOL, FREE_HOSTED_INTEGRATIONS, getVideoModelPool, getFreeHostedModelCandidates, getSelfHostedModels};
