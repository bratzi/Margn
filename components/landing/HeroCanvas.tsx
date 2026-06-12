"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

// Hero-Hintergrund: ein Meer aus „Textzeilen" — Punktreihen in Wort-Gruppen,
// die wie Druckzeilen wirken und von Simplex-Noise als ruhige Welle bewegt
// werden. Metapher: zwischen den Zeilen lesen. GPU-seitig (Vertex-Shader),
// DPR-gedeckelt, pausiert außerhalb des Viewports, reduced-motion-bewusst.

const VERT = /* glsl */ `
  uniform float uTime;
  uniform float uSize;
  attribute float aSeed;
  varying float vMix;
  varying float vAlpha;

  // 2D-Simplex-Noise (Ashima / Ian McEwan, public domain)
  vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
  float snoise(vec2 v){
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz; x12.xy -= i1;
    i = mod(i, 289.0);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m; m = m*m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }

  void main() {
    vec3 p = position;
    float t = uTime * 0.085;
    float n = snoise(vec2(p.x * 0.16 + t, p.z * 0.32 - t * 0.6));
    n += 0.45 * snoise(vec2(p.x * 0.45 - t * 1.4, p.z * 0.8 + t));
    p.y += n * 0.85;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    float dist = -mv.z;
    gl_PointSize = uSize * aSeed * (1.0 + n * 0.55) * (9.0 / dist);

    vMix = smoothstep(-1.0, 1.2, n);
    // Tiefen- und Rand-Fade: hinten und seitlich auslaufen lassen
    float edge = 1.0 - smoothstep(7.0, 13.0, abs(p.x));
    float depth = 1.0 - smoothstep(4.0, 11.0, dist - 4.0);
    vAlpha = edge * depth * (0.35 + 0.65 * vMix) * step(0.01, aSeed);
  }
`;

const FRAG = /* glsl */ `
  precision mediump float;
  uniform vec3 uColA;
  uniform vec3 uColB;
  varying float vMix;
  varying float vAlpha;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    float disc = smoothstep(0.5, 0.18, d);
    vec3 col = mix(uColA, uColB, vMix);
    gl_FragColor = vec4(col, disc * vAlpha);
  }
`;

export default function HeroCanvas() {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const small = window.matchMedia("(max-width: 768px)").matches;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: "high-performance" });
    } catch {
      return; // kein WebGL — CSS-Hintergrund übernimmt
    }
    renderer.setPixelRatio(Math.min(small ? 1.5 : 2, window.devicePixelRatio || 1));
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 60);
    const camBase = new THREE.Vector3(0, 2.35, 7.6);
    camera.position.copy(camBase);

    // Punktraster: Zeilen × Spalten, gruppiert in „Wörter" mit Lücken
    const COLS = small ? 140 : 230;
    const ROWS = small ? 46 : 72;
    const SPAN_X = 24, SPAN_Z = 13;
    const N = COLS * ROWS;
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    let i = 0;
    for (let r = 0; r < ROWS; r++) {
      let run = 0, s = 0;
      for (let c = 0; c < COLS; c++) {
        if (run <= 0) {
          run = 2 + Math.floor(Math.random() * 7); // Wortlänge
          s = 0.55 + Math.random() * 0.9;          // „Schriftstärke" je Wort
        }
        run--;
        pos[i * 3] = (c / (COLS - 1) - 0.5) * SPAN_X;
        pos[i * 3 + 1] = 0;
        pos[i * 3 + 2] = (r / (ROWS - 1) - 0.5) * SPAN_Z;
        seed[i] = run === 0 ? 0 : s; // Wortzwischenraum bleibt leer
        i++;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uSize: { value: (small ? 30 : 34) * renderer.getPixelRatio() },
        uColA: { value: new THREE.Color("#27304f") },
        uColB: { value: new THREE.Color("#6e8aff") },
      },
    });

    const points = new THREE.Points(geo, mat);
    points.position.y = -0.6;
    scene.add(points);

    // Maus-Parallaxe (nur Desktop), sanft nachgeführt
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    const onMove = (e: PointerEvent) => {
      mouse.tx = (e.clientX / window.innerWidth - 0.5) * 2;
      mouse.ty = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    if (!small && !reduced) window.addEventListener("pointermove", onMove, { passive: true });

    const resize = () => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    let raf = 0;
    let visible = true;
    const cleanupFns: Array<() => void> = [];
    const clock = new THREE.Clock();
    let elapsed = Math.random() * 100; // nicht immer dieselbe Startwelle

    const frame = () => {
      elapsed += clock.getDelta();
      mat.uniforms.uTime.value = elapsed;
      mouse.x += (mouse.tx - mouse.x) * 0.04;
      mouse.y += (mouse.ty - mouse.y) * 0.04;
      camera.position.x = camBase.x + mouse.x * 0.55;
      camera.position.y = camBase.y - mouse.y * 0.3;
      camera.lookAt(0, -0.4, 0);
      renderer.render(scene, camera);
    };

    const loop = () => {
      frame();
      raf = requestAnimationFrame(loop);
    };

    if (reduced) {
      // Ein statisches Bild genügt
      frame();
    } else {
      const io = new IntersectionObserver(([e]) => {
        const wasVisible = visible;
        visible = e.isIntersecting;
        if (visible && !wasVisible) { clock.getDelta(); raf = requestAnimationFrame(loop); }
        if (!visible) cancelAnimationFrame(raf);
      });
      io.observe(el);
      raf = requestAnimationFrame(loop);
      const onVis = () => {
        cancelAnimationFrame(raf);
        if (!document.hidden && visible) { clock.getDelta(); raf = requestAnimationFrame(loop); }
      };
      document.addEventListener("visibilitychange", onVis);
      cleanupFns.push(() => { io.disconnect(); document.removeEventListener("visibilitychange", onVis); });
    }

    return () => {
      cancelAnimationFrame(raf);
      cleanupFns.forEach((fn) => fn());
      window.removeEventListener("pointermove", onMove);
      ro.disconnect();
      geo.dispose();
      mat.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={ref} className="mg-hero-canvas" aria-hidden />;
}
