import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js";

const canvas=document.querySelector("#studioCanvas");
const viewport=document.querySelector("#studioViewport");
if(canvas&&viewport){
  try{
    const scene=new THREE.Scene();
    scene.fog=new THREE.FogExp2(0x09121a,.055);
    const camera=new THREE.PerspectiveCamera(38,1,.1,100);
    camera.position.set(0,2.7,9.2);
    const renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:!(/Android/i.test(navigator.userAgent))});
    renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.6));
    renderer.outputColorSpace=THREE.SRGBColorSpace;
    renderer.toneMapping=THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure=1.15;
    scene.add(new THREE.HemisphereLight(0xbfeeff,0x17202c,2.0));
    const key=new THREE.DirectionalLight(0xd7f4ff,3.2);key.position.set(4,6,5);scene.add(key);
    const rim=new THREE.PointLight(0x55d9ee,24,15);rim.position.set(-4,2,2);scene.add(rim);
    const warm=new THREE.PointLight(0xf3a96a,12,12);warm.position.set(3,-1,-3);scene.add(warm);
    const rig=new THREE.Group();scene.add(rig);
    const core=new THREE.Mesh(new THREE.IcosahedronGeometry(1.05,4),new THREE.MeshPhysicalMaterial({color:0x263b4b,metalness:.82,roughness:.2,clearcoat:1,clearcoatRoughness:.12,emissive:0x071b25,emissiveIntensity:.5}));
    rig.add(core);
    const inner=new THREE.Mesh(new THREE.IcosahedronGeometry(.72,2),new THREE.MeshStandardMaterial({color:0x85d7e5,metalness:.5,roughness:.22,wireframe:true,transparent:true,opacity:.34}));rig.add(inner);
    const ringMat=new THREE.MeshStandardMaterial({color:0x86ddec,metalness:.72,roughness:.22,emissive:0x1d8499,emissiveIntensity:.5});
    for(let i=0;i<3;i++){const ring=new THREE.Mesh(new THREE.TorusGeometry(1.65+i*.22,.012,8,160),ringMat);ring.rotation.set(.8+i*.55,.3+i*.65,.2+i*.4);rig.add(ring);}
    const orbitGroup=new THREE.Group();rig.add(orbitGroup);
    for(let i=0;i<28;i++){const a=i/28*Math.PI*2;const bead=new THREE.Mesh(new THREE.SphereGeometry(i%4===0?.045:.018,12,8),new THREE.MeshStandardMaterial({color:i%4===0?0xffc58d:0x8cd9e7,emissive:i%4===0?0x8c4c20:0x145566,emissiveIntensity:1.4}));bead.position.set(Math.cos(a)*2.05,Math.sin(a)*.6,Math.sin(a)*1.6);orbitGroup.add(bead);}
    const floor=new THREE.Mesh(new THREE.CircleGeometry(4.6,80),new THREE.MeshBasicMaterial({color:0x10232c,transparent:true,opacity:.55}));floor.rotation.x=-Math.PI/2;floor.position.y=-2.05;scene.add(floor);
    const grid=new THREE.GridHelper(12,36,0x36798a,0x23404c);grid.position.y=-2.04;grid.material.transparent=true;grid.material.opacity=.24;scene.add(grid);
    const particles=new THREE.BufferGeometry();const pts=[];for(let i=0;i<260;i++){pts.push((Math.random()-.5)*12,(Math.random()-.5)*6,(Math.random()-.5)*8-1);}particles.setAttribute("position",new THREE.Float32BufferAttribute(pts,3));const dust=new THREE.Points(particles,new THREE.PointsMaterial({color:0x9bdce8,size:.018,transparent:true,opacity:.6}));scene.add(dust);
    let targetX=0,targetY=0,drag=false,lastX=0,lastY=0,zoom=9.2;
    const resize=()=>{const w=viewport.clientWidth,h=viewport.clientHeight;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();};new ResizeObserver(resize).observe(viewport);resize();
    viewport.addEventListener("pointerdown",e=>{if(e.target.closest("button"))return;drag=true;lastX=e.clientX;lastY=e.clientY;viewport.setPointerCapture(e.pointerId);});
    viewport.addEventListener("pointermove",e=>{if(!drag)return;targetY+=(e.clientX-lastX)*.006;targetX+=(e.clientY-lastY)*.004;targetX=THREE.MathUtils.clamp(targetX,-.6,.6);lastX=e.clientX;lastY=e.clientY;});
    viewport.addEventListener("pointerup",()=>drag=false);viewport.addEventListener("pointercancel",()=>drag=false);
    viewport.addEventListener("wheel",e=>{zoom=THREE.MathUtils.clamp(zoom+e.deltaY*.008,6.5,12);},{passive:true});
    const reduced=matchMedia("(prefers-reduced-motion: reduce)").matches;let frame=0;
    function animate(){if(!document.hidden){frame+=.008;rig.rotation.y+=(targetY-rig.rotation.y)*.035;rig.rotation.x+=(targetX-rig.rotation.x)*.035;if(!drag){rig.rotation.y+=reduced?.0005:.0025;orbitGroup.rotation.y=reduced?0:frame*.28;}camera.position.z+=(zoom-camera.position.z)*.06;core.rotation.x=frame*.12;inner.rotation.y=-frame*.18;dust.rotation.y=frame*.012;renderer.render(scene,camera);}requestAnimationFrame(animate);}animate();
    const views={
      studio:["DIRECTOR'S BAY","Your studio is ready.","A real-time 3D environment. Drag to explore."],
      scenes:["SCENE PLANNER","Every shot has a purpose.","Build the story, then bring each scene to life."],
      system:["SYSTEM MONITOR","Production systems standing by.","Live service status appears when a task is running."]
    };
    document.querySelectorAll(".studio-tab").forEach(btn=>btn.addEventListener("click",()=>{document.querySelectorAll(".studio-tab").forEach(b=>b.classList.toggle("active",b===btn));const v=views[btn.dataset.view];document.querySelector("#hudMode").textContent=v[0];document.querySelector("#hudTitle").textContent=v[1];document.querySelector("#hudDetail").textContent=v[2];}));
    document.querySelector("#enterStudio").addEventListener("click",()=>document.querySelector("#generatorForm").scrollIntoView({behavior:"smooth",block:"center"}));
  }catch(error){viewport.classList.add("studio-fallback");const detail=document.querySelector("#hudDetail");if(detail)detail.textContent="3D preview unavailable on this browser. Production controls remain available below.";}
}