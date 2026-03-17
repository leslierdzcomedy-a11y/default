import { IInputs, IOutputs } from "./generated/ManifestTypes";

// THREE is loaded as an external library declared in the manifest.
declare const THREE: typeof import("three");

// ---------------------------------------------------------------------------
//  Types
// ---------------------------------------------------------------------------

interface Entity {
  mesh: THREE.Group;
  path: [number, number][];
  pathIdx: number;
  t: number;
  speed: number;
  bobOff: number;
}

interface Enemy {
  mesh: THREE.Group;
  cx: number;
  cz: number;
  radius: number;
  speed: number;
  angle: number;
}

interface AwardObj {
  mesh: THREE.Group;
  x: number;
  z: number;
  angle: number;
  collected: boolean;
}

interface Particle {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  life: number;
}

// ---------------------------------------------------------------------------
//  PCF Control
// ---------------------------------------------------------------------------

export class AcquisitionQuestControl
  implements ComponentFramework.StandardControl<IInputs, IOutputs>
{
  // ── PCF context ──
  private _context!: ComponentFramework.Context<IInputs>;
  private _notifyOutputChanged!: () => void;
  private _container!: HTMLDivElement;

  // ── DOM refs ──
  private _root!: HTMLDivElement;
  private _canvas!: HTMLCanvasElement;
  private _scoreEl!: HTMLSpanElement;
  private _contractsEl!: HTMLSpanElement;
  private _levelEl!: HTMLSpanElement;
  private _notifEl!: HTMLDivElement;
  private _titleOverlay!: HTMLDivElement;
  private _titleTextEl!: HTMLDivElement;
  private _notifTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Three.js ──
  private _renderer!: THREE.WebGLRenderer;
  private _scene!: THREE.Scene;
  private _camera!: THREE.PerspectiveCamera;
  private _pulse1!: THREE.PointLight;
  private _pulse2!: THREE.PointLight;

  // ── Entities ──
  private _entities: Entity[] = [];
  private _enemies: Enemy[] = [];
  private _awardObjs: AwardObj[] = [];
  private _particles: Particle[] = [];
  private _geoCache: Record<number, THREE.BoxGeometry> = {};

  // ── State ──
  private _score = 0;
  private _collected = 0;
  private _level = 1;
  private _time = 0;
  private _camAngle = 0;
  private _rafHandle = 0;
  private _reduced = false;

  private static readonly AWARD_SPOTS: [number, number][] = [
    [0, 0], [2, -2], [-2, 2], [4, 0], [-4, 0],
    [0, 4], [0, -4], [2, 4], [-2, -4], [4, 2],
  ];

  // ── Initialise ──────────────────────────────────────────────────────────
  public init(
    context: ComponentFramework.Context<IInputs>,
    notifyOutputChanged: () => void,
    _state: ComponentFramework.Dictionary,
    container: HTMLDivElement,
  ): void {
    this._context = context;
    this._notifyOutputChanged = notifyOutputChanged;
    this._container = container;
    this._reduced =
      (context.parameters.reducedMotion.raw ?? false) ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    this._buildDOM();
    this._initThree();
    this._buildScene();
    this._spawnEntities();

    if (context.parameters.autoPlay.raw !== false) {
      this._startLoop();
      this._scheduleTitleDismiss();
    }
  }

  // ── Update view ─────────────────────────────────────────────────────────
  public updateView(context: ComponentFramework.Context<IInputs>): void {
    this._context = context;

    // Update title text if changed
    const newTitle =
      context.parameters.titleText.raw ?? "ACQUISITION QUEST";
    if (this._titleTextEl.textContent !== newTitle) {
      this._titleTextEl.textContent = newTitle;
    }

    // Toggle HUD
    const hudEl = this._root.querySelector<HTMLElement>(".aq-hud");
    if (hudEl) {
      hudEl.style.display =
        context.parameters.showHUD.raw !== false ? "flex" : "none";
    }

    // Reduced motion toggle
    this._reduced =
      (context.parameters.reducedMotion.raw ?? false) ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // ── Get outputs ─────────────────────────────────────────────────────────
  public getOutputs(): IOutputs {
    return {
      score: this._score,
      level: this._level,
      contractsCollected: this._collected,
    };
  }

  // ── Destroy ─────────────────────────────────────────────────────────────
  public destroy(): void {
    cancelAnimationFrame(this._rafHandle);
    if (this._notifTimer) clearTimeout(this._notifTimer);
    this._renderer.dispose();
    this._root.remove();
  }

  // ── DOM construction ────────────────────────────────────────────────────
  private _buildDOM(): void {
    this._root = document.createElement("div");
    this._root.className = "acquisition-quest-root";

    // Canvas
    this._canvas = document.createElement("canvas");
    this._canvas.className = "aq-canvas";
    this._canvas.setAttribute("role", "img");
    this._canvas.setAttribute(
      "aria-label",
      "3D retro pixel-game animation of the acquisition workforce",
    );
    this._root.appendChild(this._canvas);

    // Scanlines + vignette (decorative)
    const scanlines = document.createElement("div");
    scanlines.className = "aq-scanlines";
    scanlines.setAttribute("aria-hidden", "true");
    this._root.appendChild(scanlines);

    const vignette = document.createElement("div");
    vignette.className = "aq-vignette";
    vignette.setAttribute("aria-hidden", "true");
    this._root.appendChild(vignette);

    // HUD
    const hud = document.createElement("div");
    hud.className = "aq-hud";
    hud.setAttribute("role", "status");
    hud.setAttribute("aria-live", "polite");
    hud.innerHTML = `
      <div class="aq-hud-col">
        <div>SCORE</div>
        <div class="aq-hud-val"><span id="aq-score">000000</span></div>
      </div>
      <div class="aq-hud-col" style="text-align:center">
        <div style="color:#ff8800">ACQUISITION QUEST</div>
        <div style="color:#00ffff;font-size:7px">LEVEL&nbsp;<span id="aq-level">01</span></div>
      </div>
      <div class="aq-hud-col" style="text-align:right">
        <div>CONTRACTS</div>
        <div class="aq-hud-val"><span id="aq-contracts">00/10</span></div>
      </div>`;
    this._root.appendChild(hud);

    this._scoreEl     = hud.querySelector<HTMLSpanElement>("#aq-score")!;
    this._contractsEl = hud.querySelector<HTMLSpanElement>("#aq-contracts")!;
    this._levelEl     = hud.querySelector<HTMLSpanElement>("#aq-level")!;

    // Title overlay
    this._titleOverlay = document.createElement("div");
    this._titleOverlay.className = "aq-title-overlay";
    this._titleOverlay.setAttribute("role", "dialog");
    this._titleOverlay.setAttribute("aria-modal", "false");
    this._titleOverlay.setAttribute("aria-label", "Game title screen");

    this._titleTextEl = document.createElement("div");
    this._titleTextEl.className = "aq-game-title";
    this._titleTextEl.textContent =
      this._context.parameters.titleText.raw ?? "ACQUISITION QUEST";

    const sub = document.createElement("div");
    sub.className = "aq-game-sub";
    sub.innerHTML = "8-BIT WORKFORCE EDITION<br>AWARD CONTRACTS · DODGE RED TAPE · LEVEL UP";

    const pressStart = document.createElement("div");
    pressStart.className = "aq-press-start";
    pressStart.setAttribute("aria-live", "polite");
    pressStart.textContent = "— DEMO MODE —";

    this._titleOverlay.append(this._titleTextEl, sub, pressStart);
    this._root.appendChild(this._titleOverlay);

    // Notification
    this._notifEl = document.createElement("div");
    this._notifEl.className = "aq-notif";
    this._notifEl.setAttribute("aria-live", "assertive");
    this._notifEl.setAttribute("role", "alert");
    this._root.appendChild(this._notifEl);

    // Ticker
    const ticker = document.createElement("div");
    ticker.className = "aq-ticker";
    ticker.setAttribute("aria-hidden", "true");
    ticker.innerHTML = `<span class="aq-ticker-text">
      ★ CONTRACTING OFFICER SECURED AWARD! &nbsp;&nbsp;
      ★ COR COMPLETED PERFORMANCE REVIEW! &nbsp;&nbsp;
      ★ PROGRAM MANAGER CLOSED REQUIREMENTS! &nbsp;&nbsp;
      ★ BEWARE RED TAPE — SLOW YOUR PROCUREMENT! &nbsp;&nbsp;
      ★ COLLECT CONTRACT AWARDS TO ADVANCE THE MISSION! &nbsp;&nbsp;
      ★ ACQUISITION WORKFORCE: SERVING THE NATION SINCE 1809! &nbsp;&nbsp;
      ★ FAR PART 15 BOSS INCOMING… &nbsp;&nbsp;
    </span>`;
    this._root.appendChild(ticker);

    // Legend
    const legend = document.createElement("nav");
    legend.className = "aq-legend";
    legend.setAttribute("aria-label", "Character legend");
    legend.innerHTML = `
      <div class="aq-leg"><div class="aq-leg-dot" style="background:#4488ff"></div><span style="color:#4488ff">CONTRACTING&nbsp;OFFICER</span></div>
      <div class="aq-leg"><div class="aq-leg-dot" style="background:#44ff88"></div><span style="color:#44ff88">COR</span></div>
      <div class="aq-leg"><div class="aq-leg-dot" style="background:#ff8844"></div><span style="color:#ff8844">PROGRAM&nbsp;MGR</span></div>
      <div class="aq-leg"><div class="aq-leg-dot" style="background:#ffd700"></div><span style="color:#ffd700">CONTRACT&nbsp;AWARD</span></div>
      <div class="aq-leg"><div class="aq-leg-dot" style="background:#ff4444"></div><span style="color:#ff4444">RED&nbsp;TAPE</span></div>`;
    this._root.appendChild(legend);

    // Skip link (a11y)
    const skip = document.createElement("a");
    skip.href = "#aq-legend";
    skip.style.cssText = "position:absolute;left:-9999px;top:auto";
    skip.textContent = "Skip to legend";
    this._root.prepend(skip);

    this._container.appendChild(this._root);

    // Dismiss title on interaction
    const dismiss = (): void => this._dismissTitle();
    document.addEventListener("keydown", dismiss, { once: true });
    document.addEventListener("pointerdown", dismiss, { once: true });
  }

  // ── Three.js init ───────────────────────────────────────────────────────
  private _initThree(): void {
    this._renderer = new THREE.WebGLRenderer({
      canvas: this._canvas,
      antialias: false,
      powerPreference: "high-performance",
    });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this._renderer.shadowMap.enabled = true;
    this._renderer.shadowMap.type = THREE.BasicShadowMap;
    this._renderer.setClearColor(0x03030e);

    this._scene = new THREE.Scene();
    this._scene.fog = new THREE.FogExp2(0x03030e, 0.06);

    const w = this._container.clientWidth || 800;
    const h = this._container.clientHeight || 600;

    this._camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 120);
    this._camera.position.set(14, 16, 14);
    this._camera.lookAt(0, 0, 0);

    this._renderer.setSize(w, h);

    // Resize observer
    const ro = new ResizeObserver(() => this._onResize());
    ro.observe(this._container);
  }

  // ── Scene construction ──────────────────────────────────────────────────
  private _buildScene(): void {
    // Lighting
    this._scene.add(new THREE.AmbientLight(0x0a1030, 4));

    const sun = new THREE.DirectionalLight(0x9999ff, 4);
    sun.position.set(10, 20, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.setScalar(512);
    this._scene.add(sun);

    const fill = new THREE.DirectionalLight(0x220033, 1.5);
    fill.position.set(-10, 5, -10);
    this._scene.add(fill);

    this._pulse1 = new THREE.PointLight(0x00ff88, 4, 18);
    this._pulse1.position.set(-5, 5, -5);
    this._scene.add(this._pulse1);

    this._pulse2 = new THREE.PointLight(0xff6600, 3, 18);
    this._pulse2.position.set(5, 5, 5);
    this._scene.add(this._pulse2);

    this._buildFloor();
    this._buildBuildings();
    this._buildStars();
  }

  // ── Voxel geometry cache ────────────────────────────────────────────────
  private _vGeo(s: number): THREE.BoxGeometry {
    return (this._geoCache[s] ??= new THREE.BoxGeometry(s, s, s));
  }

  private _addVox(
    group: THREE.Group,
    gx: number,
    gy: number,
    gz: number,
    hexColor: number,
    s = 0.22,
  ): THREE.Mesh {
    const mat = new THREE.MeshLambertMaterial({
      color: hexColor,
      emissive: new THREE.Color(hexColor).multiplyScalar(0.12),
    });
    const m = new THREE.Mesh(this._vGeo(s), mat);
    m.position.set(gx * s, gy * s, gz * s);
    m.castShadow = true;
    group.add(m);
    return m;
  }

  // ── Character factories ─────────────────────────────────────────────────

  private _makeCO(): THREE.Group {
    const g = new THREE.Group();
    const [SK, HR, SU, SH, TI, LG, SH2, BR] = [
      0xffcc99, 0x331100, 0x2255cc, 0xffffff,
      0xff3333, 0x112288, 0x0a0a22, 0x7a3f10,
    ];
    this._addVox(g, -1, 8, 0, HR); this._addVox(g, 0, 8, 0, HR); this._addVox(g, 1, 8, 0, HR);
    this._addVox(g, -1, 7, 0, SK); this._addVox(g, 0, 7, 0, SK); this._addVox(g, 1, 7, 0, SK);
    this._addVox(g, -1, 6, 0, SK); this._addVox(g, 0, 6, 0, SK); this._addVox(g, 1, 6, 0, SK);
    this._addVox(g, -1, 7, 0, 0x222222, 0.1); this._addVox(g, 1, 7, 0, 0x222222, 0.1);
    this._addVox(g, 0, 5, 0, SH);
    this._addVox(g, -1, 5, 0, SU); this._addVox(g, 0, 5, 0, SH); this._addVox(g, 1, 5, 0, SU);
    this._addVox(g, -1, 4, 0, SU); this._addVox(g, 0, 4, 0, TI); this._addVox(g, 1, 4, 0, SU);
    this._addVox(g, -1, 3, 0, SU); this._addVox(g, 0, 3, 0, SU); this._addVox(g, 1, 3, 0, SU);
    this._addVox(g, -2, 5, 0, SU, 0.20); this._addVox(g, -2, 4, 0, SU, 0.20); this._addVox(g, -2, 3, 0, SK, 0.20);
    this._addVox(g, 2, 5, 0, SU, 0.20); this._addVox(g, 2, 4, 0, SU, 0.20);
    this._addVox(g, 2, 3, 0, BR, 0.20); this._addVox(g, 2, 2, 0, BR, 0.20);
    this._addVox(g, -1, 2, 0, LG); this._addVox(g, 1, 2, 0, LG);
    this._addVox(g, -1, 1, 0, LG); this._addVox(g, 1, 1, 0, LG);
    this._addVox(g, -1, 0, 0, SH2); this._addVox(g, 1, 0, 0, SH2);
    this._addVox(g, -2, 0, 0, SH2, 0.18); this._addVox(g, 2, 0, 0, SH2, 0.18);
    return g;
  }

  private _makeCOR(): THREE.Group {
    const g = new THREE.Group();
    const [SK, , VE, SH, HT, BT, SH2] = [
      0xffcc99, 0x552200, 0x22aa55, 0xdddddd, 0xffe000, 0x334411, 0x221100,
    ];
    this._addVox(g, -1, 8, 0, HT, 0.24); this._addVox(g, 0, 8, 0, HT, 0.24); this._addVox(g, 1, 8, 0, HT, 0.24);
    this._addVox(g, -2, 7, 0, HT, 0.20); this._addVox(g, 2, 7, 0, HT, 0.20);
    this._addVox(g, -1, 7, 0, SK); this._addVox(g, 0, 7, 0, SK); this._addVox(g, 1, 7, 0, SK);
    this._addVox(g, -1, 6, 0, SK); this._addVox(g, 0, 6, 0, SK); this._addVox(g, 1, 6, 0, SK);
    this._addVox(g, -1, 6, 0, 0x222222, 0.1); this._addVox(g, 1, 6, 0, 0x222222, 0.1);
    this._addVox(g, -1, 5, 0, VE); this._addVox(g, 0, 5, 0, VE); this._addVox(g, 1, 5, 0, VE);
    this._addVox(g, -1, 4, 0, VE); this._addVox(g, 0, 4, 0, SH); this._addVox(g, 1, 4, 0, VE);
    this._addVox(g, -1, 3, 0, SH); this._addVox(g, 0, 3, 0, SH); this._addVox(g, 1, 3, 0, SH);
    this._addVox(g, -2, 5, 0, SH, 0.20); this._addVox(g, -2, 4, 0, SH, 0.20); this._addVox(g, -2, 3, 0, SK, 0.20);
    this._addVox(g, 2, 5, 0, SH, 0.20); this._addVox(g, 2, 4, 0, SH, 0.20); this._addVox(g, 2, 3, 0, SK, 0.20);
    this._addVox(g, -1, 2, 0, BT); this._addVox(g, 1, 2, 0, BT);
    this._addVox(g, -1, 1, 0, BT); this._addVox(g, 1, 1, 0, BT);
    this._addVox(g, -1, 0, 0, SH2); this._addVox(g, 1, 0, 0, SH2);
    return g;
  }

  private _makePM(): THREE.Group {
    const g = new THREE.Group();
    const [SK, HR, UN, CL, PA, SH] = [
      0xffcc99, 0x111111, 0xff7722, 0xcccccc, 0xffffff, 0x222222,
    ];
    this._addVox(g, -1, 8, 0, HR); this._addVox(g, 0, 8, 0, HR); this._addVox(g, 1, 8, 0, HR);
    this._addVox(g, -1, 7, 0, SK); this._addVox(g, 0, 7, 0, SK); this._addVox(g, 1, 7, 0, SK);
    this._addVox(g, -1, 6, 0, SK); this._addVox(g, 0, 6, 0, SK); this._addVox(g, 1, 6, 0, SK);
    this._addVox(g, -1, 6, 0, 0x222222, 0.1); this._addVox(g, 1, 6, 0, 0x222222, 0.1);
    this._addVox(g, 0, 5, 0.12, 0x882222, 0.08);
    this._addVox(g, -1, 5, 0, UN); this._addVox(g, 0, 5, 0, UN); this._addVox(g, 1, 5, 0, UN);
    this._addVox(g, -1, 4, 0, UN); this._addVox(g, 0, 4, 0, UN); this._addVox(g, 1, 4, 0, UN);
    this._addVox(g, -1, 3, 0, UN); this._addVox(g, 0, 3, 0, UN); this._addVox(g, 1, 3, 0, UN);
    this._addVox(g, -2, 5, 0, UN, 0.20); this._addVox(g, -2, 4, 0, UN, 0.20); this._addVox(g, -2, 3, 0, SK, 0.20);
    this._addVox(g, 2, 5, 0, CL, 0.20); this._addVox(g, 2, 4, 0, CL, 0.20);
    this._addVox(g, 2, 5, 0.12, PA, 0.14); this._addVox(g, 2, 4, 0.12, PA, 0.14);
    this._addVox(g, 2, 3, 0, SK, 0.20);
    this._addVox(g, -1, 2, 0, UN); this._addVox(g, 1, 2, 0, UN);
    this._addVox(g, -1, 1, 0, UN); this._addVox(g, 1, 1, 0, UN);
    this._addVox(g, -1, 0, 0, SH); this._addVox(g, 1, 0, 0, SH);
    return g;
  }

  private _makeRedTape(): THREE.Group {
    const g = new THREE.Group();
    const [R, DR, W, B] = [0xee1111, 0xaa0000, 0xffffff, 0x000000];
    for (let y = 0; y < 4; y++) {
      for (let x = -1; x <= 1; x++) {
        this._addVox(g, x, y + 1, 0, (x + y) % 2 === 0 ? R : DR, 0.26);
      }
    }
    this._addVox(g, -1, 4, 0.15, W, 0.14); this._addVox(g, 1, 4, 0.15, W, 0.14);
    this._addVox(g, -1, 4, 0.22, B, 0.09); this._addVox(g, 1, 4, 0.22, B, 0.09);
    this._addVox(g, -1, 3, 0.2, B, 0.08); this._addVox(g, 0, 2, 0.2, B, 0.08); this._addVox(g, 1, 3, 0.2, B, 0.08);
    this._addVox(g, -2, 3, 0, DR, 0.18); this._addVox(g, 2, 3, 0, DR, 0.18);
    this._addVox(g, -2, 2, 0, R, 0.18);  this._addVox(g, 2, 2, 0, R, 0.18);
    return g;
  }

  private _makeAward(): THREE.Group {
    const g = new THREE.Group();
    const [GD, SV, WH] = [0xffd700, 0xaaaaaa, 0xffffff];
    const starPts: [number, number][] = [
      [0, 4], [-1, 3], [0, 3], [1, 3],
      [-2, 2], [-1, 2], [0, 2], [1, 2], [2, 2],
      [-1, 1], [0, 1], [1, 1], [0, 0],
    ];
    starPts.forEach(([x, y]) => this._addVox(g, x, y + 2, 0, GD, 0.18));
    this._addVox(g, 0, 4, 0.1, WH, 0.1);
    this._addVox(g, 0, 1, 0, SV); this._addVox(g, -1, 1, 0, SV); this._addVox(g, 1, 1, 0, SV);
    this._addVox(g, -1, 0, 0, SV); this._addVox(g, 0, 0, 0, SV); this._addVox(g, 1, 0, 0, SV);
    return g;
  }

  // ── Floor + environment ─────────────────────────────────────────────────
  private _buildFloor(): void {
    const HALF = 7;
    for (let x = -HALF; x < HALF; x++) {
      for (let z = -HALF; z < HALF; z++) {
        const even = (x + z) % 2 === 0;
        const geo = new THREE.BoxGeometry(0.96, 0.1, 0.96);
        const mat = new THREE.MeshLambertMaterial({
          color: even ? 0x0d1040 : 0x070820,
          emissive: even ? 0x000033 : 0x000011,
        });
        const tile = new THREE.Mesh(geo, mat);
        tile.position.set(x + 0.5, -0.05, z + 0.5);
        tile.receiveShadow = true;
        this._scene.add(tile);
      }
    }
    const lm = new THREE.LineBasicMaterial({
      color: 0x1133bb, transparent: true, opacity: 0.4,
    });
    for (let i = -HALF; i <= HALF; i++) {
      this._scene.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(i, 0, -HALF),
          new THREE.Vector3(i, 0, HALF),
        ]), lm));
      this._scene.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-HALF, 0, i),
          new THREE.Vector3(HALF, 0, i),
        ]), lm));
    }
  }

  private _buildBuildings(): void {
    const specs: [number, number, number, number][] = [
      [-9, -9, 4, 0x112244], [9, -9, 6, 0x112244],
      [-9, 9, 3, 0x112244],  [9, 9, 5, 0x112244],
      [-9, 0, 2, 0x0d1a33],  [9, 0, 4, 0x0d1a33],
      [0, -9, 3, 0x0d1a33],  [0, 9, 5, 0x0d1a33],
    ];
    specs.forEach(([x, z, h, c]) => {
      const geo = new THREE.BoxGeometry(1.2, h, 1.2);
      const mat = new THREE.MeshLambertMaterial({
        color: c, emissive: new THREE.Color(c).multiplyScalar(0.06),
      });
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, h / 2, z);
      m.castShadow = true;
      for (let wy = 0; wy < h - 0.5; wy += 0.7) {
        if (Math.random() > 0.45) {
          const wGeo = new THREE.BoxGeometry(0.2, 0.2, 0.02);
          const wMat = new THREE.MeshLambertMaterial({ color: 0xffff88, emissive: 0xffff44 });
          const w = new THREE.Mesh(wGeo, wMat);
          w.position.set((Math.random() - 0.5) * 0.7, wy - h / 2 + 0.35, 0.62);
          m.add(w);
        }
      }
      this._scene.add(m);
    });
  }

  private _buildStars(): void {
    const verts: number[] = [];
    for (let i = 0; i < 800; i++) {
      verts.push(
        (Math.random() - 0.5) * 130,
        Math.random() * 60 + 12,
        (Math.random() - 0.5) * 130,
      );
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    this._scene.add(
      new THREE.Points(geo, new THREE.PointsMaterial({
        color: 0x8899ff, size: 0.12, transparent: true, opacity: 0.7,
      })),
    );
  }

  // ── Spawn entities ──────────────────────────────────────────────────────
  private _spawnEntities(): void {
    const spawnChar = (
      factoryFn: () => THREE.Group,
      path: [number, number][],
      bobOff: number,
    ): void => {
      const mesh = factoryFn();
      mesh.position.set(path[0][0], 0, path[0][1]);
      this._scene.add(mesh);
      this._entities.push({ mesh, path, pathIdx: 0, t: 0, speed: 0.022 + Math.random() * 0.008, bobOff });
    };

    spawnChar(this._makeCO.bind(this),  [[-4, -4], [4, -4], [4, 4], [-4, 4]],  0);
    spawnChar(this._makeCOR.bind(this), [[0, -5],  [5, 0],  [0, 5], [-5, 0]],  Math.PI * 0.66);
    spawnChar(this._makePM.bind(this),  [[-2, -2], [2, -2], [2, 2], [-2, 2]],  Math.PI * 1.33);

    ([
      [3.5, 3.5, 2.5, 0.016],
      [-3.5, -3.5, 2, 0.019],
      [3.5, -3.5, 3, 0.014],
      [-3.5, 3.5, 1.8, 0.021],
    ] as [number, number, number, number][]).forEach(([cx, cz, radius, speed]) => {
      const mesh = this._makeRedTape();
      this._scene.add(mesh);
      this._enemies.push({ mesh, cx, cz, radius, speed, angle: Math.random() * Math.PI * 2 });
    });

    AcquisitionQuestControl.AWARD_SPOTS.forEach(([x, z]) => {
      const mesh = this._makeAward();
      mesh.position.set(x, 0, z);
      this._scene.add(mesh);
      this._awardObjs.push({ mesh, x, z, angle: Math.random() * Math.PI * 2, collected: false });
    });
  }

  // ── Particles ───────────────────────────────────────────────────────────
  private _burst(px: number, py: number, pz: number, color: number, count = 14): void {
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(
        this._vGeo(0.1),
        new THREE.MeshLambertMaterial({ color, emissive: color, transparent: true, opacity: 1 }),
      );
      m.position.set(px, py, pz);
      this._scene.add(m);
      this._particles.push({
        mesh: m,
        vx: (Math.random() - 0.5) * 0.18,
        vy: Math.random() * 0.22 + 0.06,
        vz: (Math.random() - 0.5) * 0.18,
        life: 1.0,
      });
    }
  }

  // ── HUD helpers ─────────────────────────────────────────────────────────
  private _hudUpdate(): void {
    this._scoreEl.textContent     = String(this._score).padStart(6, "0");
    this._contractsEl.textContent = `${String(this._collected).padStart(2, "0")}/${AcquisitionQuestControl.AWARD_SPOTS.length}`;
    this._levelEl.textContent     = String(this._level).padStart(2, "0");
    this._notifyOutputChanged();
  }

  private _showNotif(msg: string): void {
    this._notifEl.textContent = msg;
    this._notifEl.style.opacity = "1";
    if (this._notifTimer) clearTimeout(this._notifTimer);
    this._notifTimer = setTimeout(() => {
      this._notifEl.style.opacity = "0";
    }, 1800);
  }

  // ── Title dismiss ───────────────────────────────────────────────────────
  private _scheduleTitleDismiss(): void {
    setTimeout(() => this._dismissTitle(), 4200);
  }

  private _dismissTitle(): void {
    this._titleOverlay.classList.add("aq-hide");
    setTimeout(() => { this._titleOverlay.style.display = "none"; }, 1100);
  }

  // ── Animation loop ──────────────────────────────────────────────────────
  private _startLoop(): void {
    const tick = (): void => {
      this._rafHandle = requestAnimationFrame(tick);
      this._time += 0.016;

      if (!this._reduced) {
        this._camAngle += 0.0015;
        this._camera.position.x = Math.cos(this._camAngle) * 20;
        this._camera.position.z = Math.sin(this._camAngle) * 20;
        this._camera.position.y = 16;
        this._camera.lookAt(0, 1, 0);
      }

      this._pulse1.intensity = 3.5 + Math.sin(this._time * 1.9);
      this._pulse2.intensity = 3.0 + Math.cos(this._time * 1.4) * 0.8;

      // Characters
      this._entities.forEach(e => {
        const tgt = e.path[e.pathIdx];
        const dx = tgt[0] - e.mesh.position.x;
        const dz = tgt[1] - e.mesh.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 0.12) {
          e.pathIdx = (e.pathIdx + 1) % e.path.length;
        } else {
          e.mesh.position.x += (dx / dist) * e.speed;
          e.mesh.position.z += (dz / dist) * e.speed;
          e.mesh.rotation.y = Math.atan2(dx, dz);
        }
        e.mesh.position.y = Math.abs(Math.sin(this._time * 4 + e.bobOff)) * 0.08;
        e.mesh.scale.y    = 1 + Math.sin(this._time * 8 + e.bobOff) * 0.025;

        // Collect awards
        this._awardObjs.forEach(a => {
          if (a.collected) return;
          if (Math.hypot(a.x - e.mesh.position.x, a.z - e.mesh.position.z) < 0.9) {
            a.collected = true;
            a.mesh.visible = false;
            this._score += 1000;
            this._collected++;
            this._burst(a.x, 0.6, a.z, 0xffd700);
            this._showNotif("★ CONTRACT AWARDED! +1000");
            this._hudUpdate();
          }
        });
      });

      // Red tape
      this._enemies.forEach(en => {
        en.angle += en.speed;
        en.mesh.position.x = en.cx + Math.cos(en.angle) * en.radius;
        en.mesh.position.z = en.cz + Math.sin(en.angle) * en.radius;
        en.mesh.position.y = Math.abs(Math.sin(en.angle * 3)) * 0.1;
        en.mesh.rotation.y = en.angle;
        en.mesh.rotation.z = en.angle * 2.5;
      });

      // Awards float
      this._awardObjs.forEach(a => {
        if (a.collected) return;
        a.angle += 0.028;
        a.mesh.position.y = Math.sin(a.angle) * 0.25 + 0.4;
        a.mesh.rotation.y = a.angle;
      });

      // Particles
      for (let i = this._particles.length - 1; i >= 0; i--) {
        const p = this._particles[i];
        p.life -= 0.025;
        p.mesh.position.x += p.vx;
        p.mesh.position.y += p.vy;
        p.mesh.position.z += p.vz;
        p.vy -= 0.007;
        (p.mesh.material as THREE.MeshLambertMaterial).opacity = p.life;
        if (p.life <= 0) {
          this._scene.remove(p.mesh);
          this._particles.splice(i, 1);
        }
      }

      // Level up
      if (this._collected >= AcquisitionQuestControl.AWARD_SPOTS.length) {
        this._collected = 0;
        this._level++;
        this._score += 5000;
        this._awardObjs.forEach(a => {
          a.collected = false;
          a.mesh.visible = true;
          a.angle = Math.random() * Math.PI * 2;
        });
        this._burst(0, 2, 0, 0x00ffff, 30);
        this._showNotif(`★ LEVEL ${this._level} — MISSION COMPLETE! +5000`);
        this._hudUpdate();
      }

      this._renderer.render(this._scene, this._camera);
    };

    tick();
  }

  // ── Resize ───────────────────────────────────────────────────────────────
  private _onResize(): void {
    const w = this._container.clientWidth;
    const h = this._container.clientHeight;
    if (w > 0 && h > 0) {
      this._camera.aspect = w / h;
      this._camera.updateProjectionMatrix();
      this._renderer.setSize(w, h);
    }
  }
}
