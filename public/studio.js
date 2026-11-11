import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js";

const canvas = document.querySelector("#studioCanvas");
const viewport = document.querySelector("#studioViewport");

if (canvas && viewport) {
  try {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x081018);
    scene.fog = new THREE.Fog(0x081018, 12, 25);

    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 80);
    const cameraHome = new THREE.Vector3(0, 2.35, 10.5);
    const cameraTarget = new THREE.Vector3(0, -0.15, -0.8);
    camera.position.copy(cameraHome);
    camera.lookAt(cameraTarget);

    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: false,
      antialias: !/Android/i.test(navigator.userAgent),
      powerPreference: "low-power"
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;

    scene.add(new THREE.HemisphereLight(0xc8eaff, 0x18212a, 2.0));
    const keyLight = new THREE.DirectionalLight(0xe3f5ff, 2.6);
    keyLight.position.set(4, 8, 6);
    scene.add(keyLight);
    const cyanFill = new THREE.PointLight(0x48cbe8, 22, 16);
    cyanFill.position.set(-4, 2.5, 1);
    scene.add(cyanFill);
    const warmFill = new THREE.PointLight(0xffa45f, 15, 13);
    warmFill.position.set(4, 1, -3);
    scene.add(warmFill);

    const studio = new THREE.Group();
    scene.add(studio);

    const mat = (color, metalness = 0.2, roughness = 0.65, extra = {}) =>
      new THREE.MeshStandardMaterial({ color, metalness, roughness, ...extra });
    const dark = mat(0x17232c, 0.7, 0.42);
    const wall = mat(0x111d26, 0.45, 0.72);
    const trim = mat(0x39515e, 0.8, 0.35);
    const cyan = mat(0x54d7eb, 0.45, 0.28, { emissive: 0x0c5668, emissiveIntensity: 1.1 });
    const amber = mat(0xffb16d, 0.3, 0.3, { emissive: 0x783b16, emissiveIntensity: 1.0 });

    function box(parent, size, position, material, rotation) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
      mesh.position.set(...position);
      if (rotation) mesh.rotation.set(...rotation);
      parent.add(mesh);
      return mesh;
    }
    function cylinder(parent, radiusTop, radiusBottom, height, position, material, rotation) {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, 12), material);
      mesh.position.set(...position);
      if (rotation) mesh.rotation.set(...rotation);
      parent.add(mesh);
      return mesh;
    }
    function screenTexture(title, accent = "#6ce4ef") {
      const board = document.createElement("canvas");
      board.width = 512;
      board.height = 300;
      const ctx = board.getContext("2d");
      ctx.fillStyle = "#07131d";
      ctx.fillRect(0, 0, board.width, board.height);
      ctx.fillStyle = accent;
      ctx.font = "bold 23px Arial";
      ctx.fillText(title, 24, 42);
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.72;
      ctx.lineWidth = 3;
      ctx.strokeRect(24, 62, 464, 202);
      for (let i = 0; i < 5; i++) {
        ctx.globalAlpha = 0.25 + i * 0.08;
        ctx.fillStyle = accent;
        ctx.fillRect(48, 222 - i * 25, 38 + i * 58, 7);
      }
      ctx.globalAlpha = 0.65;
      ctx.beginPath();
      ctx.moveTo(48, 190);
      ctx.lineTo(120, 162);
      ctx.lineTo(190, 176);
      ctx.lineTo(268, 112);
      ctx.lineTo(348, 137);
      ctx.lineTo(450, 88);
      ctx.stroke();
      ctx.globalAlpha = 1;
      const texture = new THREE.CanvasTexture(board);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    }

    // A compact physical soundstage instead of an abstract orbital animation.
    box(studio, [14, 0.22, 12], [0, -1.82, -1], dark);
    box(studio, [14, 6.4, 0.22], [0, 1.35, -6.95], wall);
    box(studio, [0.22, 6.4, 12], [-7, 1.35, -1], wall);
    box(studio, [0.22, 6.4, 12], [7, 1.35, -1], wall);
    box(studio, [14, 0.18, 12], [0, 4.55, -1], dark);

    const floorGrid = new THREE.GridHelper(14, 28, 0x2a7180, 0x1d3a46);
    floorGrid.position.set(0, -1.695, -1);
    floorGrid.material.transparent = true;
    floorGrid.material.opacity = 0.28;
    studio.add(floorGrid);

    // Wall ribs, practical set panels and a backlit YTAgent sign.
    for (let x = -6; x <= 6; x += 2) {
      box(studio, [0.055, 5.8, 0.12], [x, 1.3, -6.78], trim);
    }
    const signCanvas = document.createElement("canvas");
    signCanvas.width = 720;
    signCanvas.height = 180;
    const signCtx = signCanvas.getContext("2d");
    signCtx.fillStyle = "#08151d";
    signCtx.fillRect(0, 0, 720, 180);
    signCtx.fillStyle = "#dffaff";
    signCtx.font = "800 64px Arial";
    signCtx.fillText("YTAGENT", 34, 90);
    signCtx.fillStyle = "#67d6e7";
    signCtx.font = "bold 22px Arial";
    signCtx.fillText("VIRTUAL PRODUCTION STAGE", 38, 132);
    const signTexture = new THREE.CanvasTexture(signCanvas);
    signTexture.colorSpace = THREE.SRGBColorSpace;
    box(studio, [3.9, 1.05, 0.14], [0, 2.8, -6.76], trim);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.72, 0.88), new THREE.MeshBasicMaterial({ map: signTexture }));
    sign.position.set(0, 2.8, -6.665);
    studio.add(sign);

    // Raised shooting platform with a single floor-level status strip.
    box(studio, [4.2, 0.42, 2.8], [0, -1.52, -1.55], trim);
    box(studio, [3.95, 0.12, 2.55], [0, -1.25, -1.55], dark);
    const stageLine = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.025, 0.035), cyan);
    stageLine.position.set(0, -1.18, -2.78);
    studio.add(stageLine);

    // Original friendly robot assistant standing on the stage.
    const assistant = new THREE.Group();
    assistant.position.set(0, -1.1, -1.45);
    studio.add(assistant);
    const robotBody = new THREE.Mesh(new THREE.CapsuleGeometry(0.29, 0.62, 4, 10), mat(0x9eafb9, 0.72, 0.28));
    robotBody.position.y = 0.68;
    assistant.add(robotBody);
    const robotChest = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.12), dark);
    robotChest.position.set(0, 0.78, 0.26);
    assistant.add(robotChest);
    const chestLight = new THREE.Mesh(new THREE.CircleGeometry(0.055, 20), new THREE.MeshBasicMaterial({ color: 0x72eaff }));
    chestLight.position.set(0, 0.78, 0.33);
    assistant.add(chestLight);
    const head = new THREE.Group();
    head.position.y = 1.38;
    assistant.add(head);
    const headShell = new THREE.Mesh(new THREE.SphereGeometry(0.39, 24, 18), mat(0xc2d1d8, 0.65, 0.24));
    head.add(headShell);
    const face = new THREE.Mesh(new THREE.BoxGeometry(0.49, 0.2, 0.13), mat(0x07151d, 0.55, 0.18));
    face.position.set(0, -0.015, 0.31);
    head.add(face);
    for (const x of [-0.13, 0.13]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.047, 12, 10), new THREE.MeshBasicMaterial({ color: 0x70efff }));
      eye.position.set(x, -0.015, 0.385);
      head.add(eye);
    }
    cylinder(head, 0.035, 0.035, 0.22, [0, 0.48, 0], trim);
    const antennaTip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), amber);
    antennaTip.position.set(0, 0.6, 0);
    head.add(antennaTip);
    for (const side of [-1, 1]) {
      cylinder(assistant, 0.075, 0.09, 0.5, [side * 0.42, 0.75, 0], trim, [0, 0, side * -0.28]);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), mat(0x879aa5, 0.7, 0.28));
      hand.position.set(side * 0.48, 0.48, 0.02);
      assistant.add(hand);
      cylinder(assistant, 0.12, 0.14, 0.28, [side * 0.16, 0.08, 0], dark);
    }

    // Film camera and tripod on the left side of the set.
    const cameraRig = new THREE.Group();
    cameraRig.position.set(-3.9, -0.25, 1.0);
    studio.add(cameraRig);
    const cameraBody = box(cameraRig, [0.72, 0.48, 0.62], [0, 0.62, 0], dark);
    box(cameraRig, [0.45, 0.28, 0.08], [0, 0.64, 0.35], trim);
    cylinder(cameraRig, 0.18, 0.18, 0.42, [0, 0.62, 0.52], cyan, [Math.PI / 2, 0, 0]);
    const tally = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 10), new THREE.MeshBasicMaterial({ color: 0xff4949 }));
    tally.position.set(0.27, 0.91, 0.25);
    cameraRig.add(tally);
    cylinder(cameraRig, 0.08, 0.1, 1.05, [0, 0.0, 0], trim);
    for (const angle of [0, 2.1, 4.2]) {
      const leg = cylinder(cameraRig, 0.025, 0.035, 1.35, [Math.cos(angle) * 0.35, -0.72, Math.sin(angle) * 0.35], trim);
      leg.rotation.z = Math.cos(angle) * 0.42;
      leg.rotation.x = Math.sin(angle) * 0.42;
    }
    box(cameraRig, [0.9, 0.08, 0.6], [0, -1.72, 0], dark);

    // Practical softbox lights and their stands.
    function softbox(x, z, warm = false) {
      const group = new THREE.Group();
      group.position.set(x, 0, z);
      studio.add(group);
      cylinder(group, 0.045, 0.055, 2.5, [0, -0.15, 0], trim);
      const panel = box(group, [0.9, 0.58, 0.13], [0, 1.28, 0], dark);
      panel.rotation.x = -0.22;
      const emitter = box(group, [0.72, 0.42, 0.035], [0, 1.28, 0.08], warm ? amber : cyan);
      emitter.rotation.x = -0.22;
      const lamp = new THREE.PointLight(warm ? 0xffa76c : 0x62dff2, 10, 8);
      lamp.position.set(0, 1.15, 0.25);
      group.add(lamp);
      return group;
    }
    softbox(3.9, 0.1, true);
    softbox(-2.6, -3.6, false);

    // Control desk and three functional-looking monitor surfaces in the foreground.
    const desk = new THREE.Group();
    desk.position.set(0, -1.25, 3.35);
    studio.add(desk);
    box(desk, [6.3, 0.22, 1.15], [0, 0, 0], trim);
    box(desk, [5.9, 0.1, 0.92], [0, 0.16, -0.02], dark);
    for (const x of [-2.35, 0, 2.35]) {
      box(desk, [0.12, 0.82, 0.12], [x, -0.5, -0.1], trim);
    }
    const monitors = [];
    const monitorConfigs = [
      { x: -1.95, width: 1.38, title: "SHOT LIST", color: "#69dce9" },
      { x: 0, width: 1.75, title: "DIRECTOR VIEW", color: "#ffb16d" },
      { x: 1.95, width: 1.38, title: "RENDER STATUS", color: "#69dce9" }
    ];
    for (const config of monitorConfigs) {
      const frame = box(desk, [config.width + 0.12, 0.92, 0.13], [config.x, 0.78, -0.36], dark);
      const screen = new THREE.Mesh(
        new THREE.PlaneGeometry(config.width, 0.78),
        new THREE.MeshBasicMaterial({ map: screenTexture(config.title, config.color) })
      );
      screen.position.set(config.x, 0.78, -0.285);
      desk.add(screen);
      monitors.push(screen);
      cylinder(desk, 0.035, 0.035, 0.26, [config.x, 0.22, -0.35], trim);
    }

    // Ceiling rails and hanging practical fixtures.
    box(studio, [10.5, 0.12, 0.12], [0, 4.1, -1], trim);
    box(studio, [0.12, 0.12, 8.5], [0, 4.1, -1], trim);
    for (const x of [-4.5, 0, 4.5]) {
      cylinder(studio, 0.035, 0.035, 0.8, [x, 3.65, -2], trim);
      const fixture = box(studio, [0.85, 0.16, 0.52], [x, 3.18, -2], dark);
      box(studio, [0.62, 0.035, 0.34], [x, 3.08, -1.98], cyan);
      fixture.rotation.x = -0.12;
    }

    let drag = false;
    let lastX = 0;
    let lastY = 0;
    let zoom = 10.5;
    let targetRotationX = 0;
    let targetRotationY = 0;
    let desiredCamera = cameraHome.clone();
    let desiredLook = cameraTarget.clone();
    const resize = () => {
      const width = Math.max(1, viewport.clientWidth);
      const height = Math.max(1, viewport.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    new ResizeObserver(resize).observe(viewport);
    resize();

    viewport.addEventListener("pointerdown", event => {
      if (event.target.closest("button")) return;
      drag = true;
      lastX = event.clientX;
      lastY = event.clientY;
      viewport.setPointerCapture(event.pointerId);
    });
    viewport.addEventListener("pointermove", event => {
      if (!drag) return;
      targetRotationY += (event.clientX - lastX) * 0.0045;
      targetRotationX += (event.clientY - lastY) * 0.0025;
      targetRotationX = THREE.MathUtils.clamp(targetRotationX, -0.18, 0.2);
      lastX = event.clientX;
      lastY = event.clientY;
    });
    const stopDrag = () => { drag = false; };
    viewport.addEventListener("pointerup", stopDrag);
    viewport.addEventListener("pointercancel", stopDrag);
    viewport.addEventListener("wheel", event => {
      zoom = THREE.MathUtils.clamp(zoom + event.deltaY * 0.006, 8, 13);
    }, { passive: true });

    const views = {
      studio: {
        mode: "DIRECTOR'S BAY",
        title: "Your soundstage is ready.",
        detail: "A real 3D film set. Drag to look around.",
        camera: new THREE.Vector3(0, 2.35, 10.5),
        look: new THREE.Vector3(0, -0.15, -0.8)
      },
      scenes: {
        mode: "SCENE STAGE",
        title: "Ten shots. One story.",
        detail: "The stage is where the AI scenes come to life.",
        camera: new THREE.Vector3(0, 1.35, 7.4),
        look: new THREE.Vector3(0, 0.15, -1.2)
      },
      system: {
        mode: "CONTROL ROOM",
        title: "Production systems standing by.",
        detail: "The console tracks the real YTAgent production workflow.",
        camera: new THREE.Vector3(0, 2.1, 8.2),
        look: new THREE.Vector3(0, -0.3, 2.5)
      }
    };

    document.querySelectorAll(".studio-tab").forEach(button => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".studio-tab").forEach(tab => tab.classList.toggle("active", tab === button));
        const view = views[button.dataset.view] || views.studio;
        document.querySelector("#hudMode").textContent = view.mode;
        document.querySelector("#hudTitle").textContent = view.title;
        document.querySelector("#hudDetail").textContent = view.detail;
        desiredCamera = view.camera.clone();
        desiredLook = view.look.clone();
        zoom = desiredCamera.z;
      });
    });

    document.querySelector("#enterStudio").addEventListener("click", () => {
      document.querySelector("#generatorForm").scrollIntoView({ behavior: "smooth", block: "center" });
    });

    let productionState = "idle";
    window.addEventListener("ytagent:generation", event => {
      const detail = event.detail || {};
      productionState = detail.state || "active";
      const progress = Number(detail.progress) || 0;
      const mode = document.querySelector("#hudMode");
      const title = document.querySelector("#hudTitle");
      const subtitle = document.querySelector("#hudDetail");
      if (productionState === "completed") {
        mode.textContent = "FILM COMPLETE";
        title.textContent = "Your film is ready.";
        subtitle.textContent = "The finished MP4 is waiting in your download panel.";
        chestLight.material.color.set(0x7dffb2);
        tally.material.color.set(0x7dffb2);
        monitors.forEach(monitor => monitor.material.color.set(0xb5ffda));
        return;
      }
      if (productionState === "failed") {
        mode.textContent = "PRODUCTION ALERT";
        title.textContent = "The render needs attention.";
        subtitle.textContent = "YTAgent stopped safely instead of delivering a broken film.";
        chestLight.material.color.set(0xff6262);
        tally.material.color.set(0xff4545);
        monitors.forEach(monitor => monitor.material.color.set(0xff8b8b));
        return;
      }
      chestLight.material.color.set(0x72eaff);
      tally.material.color.set(0xff4949);
      monitors.forEach(monitor => monitor.material.color.set(0xffffff));
      if (progress < 8) {
        mode.textContent = "AI DIRECTOR";
        title.textContent = "Planning the story.";
        subtitle.textContent = "Researching facts and arranging ten distinct shots.";
      } else if (progress < 67) {
        mode.textContent = "VIRTUAL FILM STAGE";
        title.textContent = "Rendering scene " + Math.max(1, Math.min(10, Math.ceil((progress - 5) / 6))) + " of 10.";
        subtitle.textContent = "Wan is building the physical action and camera movement.";
      } else if (progress < 97) {
        mode.textContent = "VOICE BOOTH";
        title.textContent = "Recording the narrator.";
        subtitle.textContent = "Kokoro is preparing the documentary voice tracks.";
      } else {
        mode.textContent = "EDIT SUITE";
        title.textContent = "Finishing the film.";
        subtitle.textContent = "Mixing scenes, captions and narration, then checking the MP4.";
      }
    });

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let tick = 0;
    function animate() {
      requestAnimationFrame(animate);
      if (document.hidden) return;
      tick += 0.012;
      studio.rotation.y += (targetRotationY - studio.rotation.y) * 0.035;
      studio.rotation.x += (targetRotationX - studio.rotation.x) * 0.035;
      if (!drag && !reducedMotion) {
        targetRotationY += 0.00015;
      }
      head.rotation.y = Math.sin(tick * 0.55) * (productionState === "active" ? 0.24 : 0.12);
      head.rotation.x = Math.sin(tick * 0.32) * 0.025;
      tally.material.emissiveIntensity = 0.4 + (Math.sin(tick * 3.5) + 1) * 0.65;
      monitors.forEach((monitor, index) => {
        monitor.position.y = 0.78 + Math.sin(tick * 0.8 + index) * 0.008;
      });
      camera.position.lerp(desiredCamera, 0.035);
      camera.position.z += (zoom - camera.position.z) * 0.025;
      camera.lookAt(desiredLook);
      renderer.render(scene, camera);
    }
    animate();
  } catch (error) {
    viewport.classList.add("studio-fallback");
    const detail = document.querySelector("#hudDetail");
    if (detail) detail.textContent = "3D preview unavailable on this browser. Production controls remain available below.";
  }
}
