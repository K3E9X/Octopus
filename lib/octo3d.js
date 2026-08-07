// Octopus 3D — two scenes, one file, no build step.
//
//   <octo-hero>    the creature: a hairline head with eight tentacles that reach out,
//                  touch the sources drifting around it, and send what they find back
//                  down the arm to the centre.
//   <source-orb>   the collection surface: every source Octopus can reach, placed on a
//                  sphere, swept by a scan ring, wired by the correlations it finds.
//
// Art direction inherited from the app: void ground, hairlines, desaturated cyan as the
// single hero accent, with the app's own type colours (amber = email, violet = alias)
// used only to distinguish what a node IS. No glow soup, no gradients.

// three is BUNDLED, not pulled from a CDN at runtime (HANDOFF.md appendix sanctions
// this). For a tool whose whole egress posture is about not announcing itself, a
// third-party script fetched on every page load is exactly the wrong dependency —
// and it is one more supply chain that can change under you without notice.
import * as THREE from "three";

// Accent is read from the page's --accent CSS variable when present, so the 3D matches
// whatever theme the app is in (abyss orange, the old cyan, the light palette…). The
// hex fallback is the abyss orange. AMBER / VIOLET only type what a node IS, never brand.
function cssHex(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!v) return fallback;
    const c = new THREE.Color(v);
    return c.getHex();
  } catch (e) { return fallback; }
}
let ACCENT = cssHex("--accent", 0xff8a3d);
const AMBER = 0xd6b98f;
const VIOLET = 0xb3a6d6;
const INK = 0x7c7c88;

const R = (a, b) => a + Math.random() * (b - a);

class Scene3D extends HTMLElement {
  connectedCallback() {
    if (this._up) return;
    this._up = true;
    this.style.display = "block";
    this.style.position = this.style.position || "relative";

    const w = this.clientWidth || 800, h = this.clientHeight || 600;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
    this.renderer.setSize(w, h);
    this.renderer.domElement.style.cssText = "display:block;width:100%;height:100%";
    this.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 200);
    this.camera.position.set(0, 0, 13);
    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.pointer = new THREE.Vector2(0, 0);
    this._onMove = (e) => {
      const r = this.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
    };
    window.addEventListener("pointermove", this._onMove, { passive: true });

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this);

    this.build();
    this.clock = new THREE.Clock();
    this.visible = true;
    this._io = new IntersectionObserver((es) => { this.visible = es[0].isIntersecting; }, { threshold: 0.01 });
    this._io.observe(this);
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      if (!this.visible || document.hidden) return;
      this.tick(this.clock.getDelta(), this.clock.elapsedTime);
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  disconnectedCallback() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener("pointermove", this._onMove);
    this._ro?.disconnect();
    this._io?.disconnect();
    this.renderer?.dispose();
    this._up = false;
  }

  resize() {
    const w = this.clientWidth, h = this.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}

/* ------------------------------------------------------------------ the creature */

class OctoHero extends Scene3D {
  build() {
    const S = this.scene;
    S.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.PointLight(ACCENT, 60, 40);
    key.position.set(4, 5, 8);
    S.add(key);

    // head — two nested hairline shells, so it reads as a membrane, not a ball
    const shell = (r, detail, color, op) => {
      const m = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(r, detail)),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: op })
      );
      this.root.add(m);
      return m;
    };
    this.shellA = shell(1.62, 2, ACCENT, 0.34);
    this.shellB = shell(1.18, 1, INK, 0.4);
    this.core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.36, 2),
      new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.95 })
    );
    this.root.add(this.core);

    // sources drifting in the dark — what the arms go and get
    this.sources = [];
    const KINDS = [
      { c: ACCENT, n: 7 }, { c: AMBER, n: 4 }, { c: VIOLET, n: 4 }, { c: INK, n: 7 },
    ];
    KINDS.forEach(({ c, n }) => {
      for (let i = 0; i < n; i++) {
        const g = new THREE.Group();
        const mesh = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.13, 0),
          new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.55, wireframe: true })
        );
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.22, 0.235, 24),
          new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0, side: THREE.DoubleSide })
        );
        g.add(mesh, ring);
        const a = R(0, Math.PI * 2), b = Math.acos(R(-1, 1)), rad = R(4.2, 7.4);
        g.position.setFromSphericalCoords(rad, b, a);
        this.root.add(g);
        this.sources.push({ g, mesh, ring, color: c, base: g.position.clone(), ph: R(0, 9), hit: 0 });
      }
    });

    // eight arms. A tube rebuilt each frame from a spline that is itself driven by the
    // reach target — so the arm bends into the grab instead of playing an animation.
    this.arms = [];
    const mat = () => new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.5 });
    for (let i = 0; i < 8; i++) {
      const dir = new THREE.Vector3().setFromSphericalCoords(1, Math.acos(1 - (2 * (i + 0.5)) / 8), (i * Math.PI * 2) / 8 * 1.618);
      const pts = Array.from({ length: 6 }, () => new THREE.Vector3());
      const curve = new THREE.CatmullRomCurve3(pts);
      const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.032, 6, false), mat());
      const tip = new THREE.Mesh(
        new THREE.SphereGeometry(0.075, 10, 10),
        new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.9 })
      );
      const carry = new THREE.Mesh(
        new THREE.SphereGeometry(0.055, 8, 8),
        new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0 })
      );
      this.root.add(mesh, tip, carry);
      this.arms.push({ dir, pts, curve, mesh, tip, carry, target: null, reach: 0, phase: R(0, 9), state: "seek", wait: R(0, 3), carryT: 0 });
    }
  }

  pick(arm) {
    // the arm goes for what is nearest its own direction, and never for a source
    // another arm already holds
    let best = null, bs = -2;
    for (const s of this.sources) {
      if (s.taken) continue;
      const d = s.g.position.clone().normalize().dot(arm.dir);
      if (d > bs) { bs = d; best = s; }
    }
    if (best) { best.taken = true; arm.target = best; arm.state = "reach"; }
  }

  tick(dt, t) {
    const root = this.root;
    root.rotation.y += dt * 0.06;
    root.rotation.x = THREE.MathUtils.lerp(root.rotation.x, this.pointer.y * 0.3, 0.05);
    root.rotation.z = THREE.MathUtils.lerp(root.rotation.z, -this.pointer.x * 0.12, 0.05);
    this.camera.position.x = THREE.MathUtils.lerp(this.camera.position.x, this.pointer.x * 1.6, 0.04);
    this.camera.position.y = THREE.MathUtils.lerp(this.camera.position.y, this.pointer.y * 1.1, 0.04);
    this.camera.lookAt(0, 0, 0);

    const breathe = 1 + Math.sin(t * 0.9) * 0.035;
    this.shellA.scale.setScalar(breathe);
    this.shellB.scale.setScalar(2 - breathe);
    this.shellA.rotation.y -= dt * 0.12;
    this.shellB.rotation.x += dt * 0.09;
    this.core.scale.setScalar(1 + Math.sin(t * 3.1) * 0.12);

    for (const s of this.sources) {
      s.g.position.copy(s.base).addScaledVector(
        new THREE.Vector3(Math.sin(t * 0.4 + s.ph), Math.cos(t * 0.33 + s.ph * 1.7), Math.sin(t * 0.27 + s.ph * 0.6)), 0.34
      );
      s.mesh.rotation.x += dt * 0.5; s.mesh.rotation.y += dt * 0.7;
      s.ring.lookAt(this.camera.position);
      if (s.hit > 0) {
        s.hit = Math.max(0, s.hit - dt * 1.6);
        s.ring.material.opacity = s.hit * 0.8;
        s.ring.scale.setScalar(1 + (1 - s.hit) * 2.2);
        s.mesh.material.opacity = 0.55 + s.hit * 0.45;
      }
    }

    for (const arm of this.arms) {
      if (arm.state === "seek") {
        arm.wait -= dt;
        if (arm.wait <= 0) this.pick(arm);
      }
      const want = arm.state === "reach" ? 1 : arm.state === "hold" ? 1 : 0;
      arm.reach += (want - arm.reach) * dt * (arm.state === "retract" ? 1.4 : 2.2);

      const home = arm.dir.clone().multiplyScalar(1.05);
      const tgt = arm.target ? arm.target.g.position : arm.dir.clone().multiplyScalar(3.4);
      const rest = arm.dir.clone().multiplyScalar(3.2);
      const end = rest.clone().lerp(tgt, arm.reach);

      // curl: the arm coils in the plane perpendicular to its own direction
      const side = new THREE.Vector3().crossVectors(arm.dir, new THREE.Vector3(0, 1, 0.3)).normalize();
      const up = new THREE.Vector3().crossVectors(arm.dir, side).normalize();
      for (let i = 0; i < arm.pts.length; i++) {
        const u = i / (arm.pts.length - 1);
        const p = home.clone().lerp(end, u);
        const swing = Math.sin(t * 1.6 + arm.phase + u * 4.2) * (0.55 * u) * (1 - arm.reach * 0.55);
        const curl = Math.cos(t * 1.1 + arm.phase * 1.4 + u * 3.1) * (0.42 * u) * (1 - arm.reach * 0.55);
        p.addScaledVector(side, swing).addScaledVector(up, curl);
        arm.pts[i].copy(p);
      }
      arm.curve.points = arm.pts;
      arm.mesh.geometry.dispose();
      arm.mesh.geometry = new THREE.TubeGeometry(arm.curve, 40, 0.028 + 0.02 * (1 - arm.reach), 6, false);
      arm.mesh.material.opacity = 0.34 + arm.reach * 0.4;
      arm.tip.position.copy(arm.pts[arm.pts.length - 1]);
      arm.tip.scale.setScalar(0.85 + arm.reach * 0.7);

      if (arm.state === "reach" && arm.reach > 0.93) {
        arm.state = "hold"; arm.wait = R(0.5, 1.4);
        if (arm.target) arm.target.hit = 1;
        arm.carryT = 0;
        arm.carry.material.opacity = 0.95;
      } else if (arm.state === "hold") {
        arm.wait -= dt;
        // the find travels back down the arm to the head — collection becoming evidence
        arm.carryT = Math.min(1, arm.carryT + dt * 0.9);
        arm.curve.getPoint(1 - arm.carryT, arm.carry.position);
        arm.carry.material.opacity = 0.95 * (1 - arm.carryT * 0.6);
        if (arm.carryT >= 1) { arm.carry.material.opacity = 0; this.core.scale.setScalar(1.5); }
        if (arm.wait <= 0) {
          arm.state = "retract";
          if (arm.target) arm.target.taken = false;
          arm.target = null;
          arm.wait = R(0.4, 2.2);
        }
      } else if (arm.state === "retract" && arm.reach < 0.06) {
        arm.state = "seek"; arm.wait = R(0.3, 2);
      }
    }
  }
}

/* ------------------------------------------------------- the collection surface */

class SourceOrb extends Scene3D {
  build() {
    this.camera.position.set(0, 0, 10.5);
    const N = 220;
    const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    this.pts = [];
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y), th = i * 2.399963;
      const v = new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r).multiplyScalar(3.6);
      v.toArray(pos, i * 3);
      c.set(i % 11 === 0 ? AMBER : i % 7 === 0 ? VIOLET : i % 3 === 0 ? ACCENT : INK);
      c.toArray(col, i * 3);
      this.pts.push({ v, base: c.clone(), lit: 0, i });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.cloud = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.085, vertexColors: true, transparent: true, opacity: 0.9 }));
    this.root.add(this.cloud);
    this.colAttr = g.getAttribute("color");

    this.wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(3.6, 1)),
      new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.12 })
    );
    this.root.add(this.wire);

    // the scan ring: the sweep that decides which sources answer this pass
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(3.62, 0.012, 6, 120),
      new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.6 })
    );
    this.ring.rotation.x = Math.PI / 2;
    this.root.add(this.ring);

    // correlations drawn as chords between sources that agreed
    this.links = [];
    const lg = new THREE.BufferGeometry();
    this.linkPos = new Float32Array(60 * 2 * 3);
    lg.setAttribute("position", new THREE.BufferAttribute(this.linkPos, 3));
    this.linkMesh = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.3 }));
    this.root.add(this.linkMesh);
  }

  tick(dt, t) {
    this.root.rotation.y += dt * 0.12;
    this.root.rotation.x = THREE.MathUtils.lerp(this.root.rotation.x, -0.25 + this.pointer.y * 0.35, 0.05);
    this.ring.position.y = Math.sin(t * 0.5) * 3.4;
    const rr = Math.sqrt(Math.max(0.02, 3.6 * 3.6 - this.ring.position.y ** 2)) / 3.62;
    this.ring.scale.setScalar(rr);

    const arr = this.colAttr.array;
    let n = 0;
    const white = new THREE.Color(0xffffff);
    for (const p of this.pts) {
      if (Math.abs(p.v.y - this.ring.position.y) < 0.16 && p.lit <= 0) p.lit = 1;
      if (p.lit > 0) {
        p.lit = Math.max(0, p.lit - dt * 0.8);
        const c = p.base.clone().lerp(white, p.lit * 0.75);
        c.toArray(arr, p.i * 3);
        if (n < 60) {
          const q = this.pts[(p.i * 37) % this.pts.length];
          p.v.toArray(this.linkPos, n * 6);
          q.v.toArray(this.linkPos, n * 6 + 3);
          n++;
        }
      } else p.base.toArray(arr, p.i * 3);
    }
    for (let k = n; k < 60; k++) this.linkPos.fill(0, k * 6, k * 6 + 6);
    this.colAttr.needsUpdate = true;
    this.linkMesh.geometry.getAttribute("position").needsUpdate = true;
  }
}

customElements.define("octo-hero", OctoHero);
customElements.define("source-orb", SourceOrb);
