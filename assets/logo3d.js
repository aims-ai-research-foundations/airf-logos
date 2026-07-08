/* Turn a flat logo SVG into an auto-spinning, orbit-able extruded 3D object.
   variant-A: fixes the two broken marks while preserving the filled-extrude logos.

   - ASCENDER: its SVG is a *flat isometric drawing* of a cube (a hexagon silhouette
     with a gold "A" painted on the front face). Extruding that art can only ever make
     a flat purple slab with a bright top and no readable "A". So for ascender we DO
     NOT extrude the SVG at all — we build a GENUINE 3D object: a solid purple brand
     cube with a gold caret-"A" mounted (extruded, protruding) on all four side faces,
     so the "A" stays visible as it auto-rotates.
       Detection: the ascender SVG is the only mark that uses a url() gradient fill with
       id "ag" (fill="url(#ag)"). We branch on svgText containing 'url(#ag)'.

   - MONOLINE: a stroke-only mark. The old code built one solid prism per subpath and
     added each as its own mesh; overlapping prisms at the staircase joints and where
     the gold summit meets the purple legs had coincident/near-coplanar faces across
     separate meshes -> classic z-fighting that blinks under rotation. Fix: (a) bake a
     tiny per-subpath z stagger so no two caps are exactly coplanar, (b) MERGE all
     same-coloured stroke geometry into ONE BufferGeometry (one deterministic draw call,
     no inter-mesh face contention), (c) push the gold clearly in front of the purple so
     the two colours are never coplanar, (d) a single, non-escalating polygonOffset per
     colour. logarithmicDepthBuffer is kept.

   Untouched: blocks / ascent / impossible (filled-polygon extrudes) render exactly as
   before, plus the public API window.LogoExtrude.init(canvas, svgText), OrbitControls,
   autoRotate, IntersectionObserver pause, and camera framing/centering. */
(function (g) {
  function vbSize(svg) {
    const m = svg.match(/viewBox="([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)"/);
    return m ? { w: +m[3], h: +m[4] } : { w: 200, h: 200 };
  }
  // Resolve a real fill colour. SVGLoader leaves path.color at its default when the
  // fill is a gradient reference (fill="url(#id)") -> we dig the gradient's first
  // stop-color out of the raw SVG so gradient-filled marks aren't rendered blank/white.
  function resolveFill(THREE, style, p, svgText) {
    const f = style && style.fill;
    if (typeof f === 'string' && f.indexOf('url(') === 0) {
      const idm = f.match(/url\(\s*#?([^)\s]+)\s*\)/);
      if (idm) {
        const re = new RegExp('id="' + idm[1] + '"[\\s\\S]*?stop-color="([^"]+)"');
        const sm = svgText.match(re);
        if (sm) { try { return new THREE.Color(sm[1]); } catch (e) {} }
      }
      return new THREE.Color('#6B4CA6');
    }
    return p.color ? p.color : new THREE.Color('#6B4CA6');
  }
  // Take a flat (z=0) stroke ribbon geometry from SVGLoader.pointsToStroke and turn it
  // into a closed solid prism of the given depth: front cap at z=0, back cap at z=-depth,
  // plus side walls along the ribbon's boundary edges. Yields a genuine 3D bar for
  // stroke-only marks instead of a paper-thin ribbon.
  function thicken(THREE, flat, depth) {
    flat = flat.index ? flat.toNonIndexed() : flat;
    const pos = flat.getAttribute('position');
    const N = pos.count;
    const out = [];
    const key = (x, y) => Math.round(x * 1000) + ',' + Math.round(y * 1000);
    const edgeKey = (a, b) => (a < b ? a + ';' + b : b + ';' + a);
    const edges = new Map();
    const zf = 0, zb = -depth;
    for (let i = 0; i < N; i += 3) {
      const ax = pos.getX(i), ay = pos.getY(i);
      const bx = pos.getX(i + 1), by = pos.getY(i + 1);
      const cx = pos.getX(i + 2), cy = pos.getY(i + 2);
      // front cap (original winding)
      out.push(ax, ay, zf, bx, by, zf, cx, cy, zf);
      // back cap (reversed winding so it faces outward)
      out.push(ax, ay, zb, cx, cy, zb, bx, by, zb);
      const ka = key(ax, ay), kb = key(bx, by), kc = key(cx, cy);
      [[ka, ay, ax, kb, by, bx], [kb, by, bx, kc, cy, cx], [kc, cy, cx, ka, ay, ax]]
        .forEach(function (e) {
          const k = edgeKey(e[0], e[3]);
          const rec = edges.get(k);
          if (rec) rec.n++;
          else edges.set(k, { n: 1, x1: e[2], y1: e[1], x2: e[5], y2: e[4] });
        });
    }
    // boundary edges (belong to exactly one triangle) -> side walls
    edges.forEach(function (e) {
      if (e.n !== 1) return;
      out.push(e.x1, e.y1, zf, e.x2, e.y2, zf, e.x2, e.y2, zb);
      out.push(e.x1, e.y1, zf, e.x2, e.y2, zb, e.x1, e.y1, zb);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    geo.computeVertexNormals();
    return geo;
  }
  // Concatenate several position-only BufferGeometries into one (r128 has no
  // BufferGeometryUtils in the vendored build). One geometry == one deterministic draw
  // call, which removes the cross-mesh coincident-face z-fighting that made monoline blink.
  function mergeGeos(THREE, list) {
    let total = 0;
    list.forEach(gm => { total += gm.getAttribute('position').array.length; });
    const arr = new Float32Array(total);
    let o = 0;
    list.forEach(gm => { const a = gm.getAttribute('position').array; arr.set(a, o); o += a.length; });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    geo.computeVertexNormals();
    return geo;
  }
  // A gold colour is treated as the "accent" and floated in front of the purple body.
  function isAccent(c) { return c.r > 0.68 && c.g > 0.5 && c.b < 0.55; }

  // --- ASCENDER: build a real purple cube with a gold caret-"A" on all four sides ---
  // The gold "A" is reconstructed as a clean caret (two legs forming a peak) plus a
  // crossbar — three extruded solids per face, the crossbar floated a hair proud so it
  // never shares a face-plane with the legs. Everything is a genuine mesh, so it reads
  // as "a cube with a gold A" and stays legible while it spins.
  function buildAscender(THREE) {
    const C = 100;                 // cube edge (absolute size is irrelevant; camera reframes)
    const root = new THREE.Group();

    // brand-purple cube, shaded both by per-face colour and by the scene lights
    const faceCols = ['#4A2F7A', '#4A2F7A', '#6B4CA6', '#331F57', '#4A2F7A', '#4A2F7A']; // +x -x +y -y +z -z
    const cubeMats = faceCols.map(hex => new THREE.MeshStandardMaterial({
      color: new THREE.Color(hex), roughness: 0.55, metalness: 0.15
    }));
    root.add(new THREE.Mesh(new THREE.BoxGeometry(C, C, C), cubeMats));

    // gold caret-"A" prototype, built in a local box x[-48,48] y[0,100], then centred
    const gold = new THREE.MeshStandardMaterial({
      color: new THREE.Color('#F6C63C'), roughness: 0.4, metalness: 0.25, side: THREE.DoubleSide
    });
    const e = 14; // extrusion (protrusion) depth in local units
    function bar(pts, zoff) {
      const s = new THREE.Shape();
      s.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
      s.closePath();
      const gm = new THREE.ExtrudeGeometry(s, {
        depth: e, bevelEnabled: true, bevelThickness: 1.6, bevelSize: 1.2, bevelSegments: 1
      });
      gm.translate(0, -50, zoff); // centre vertically; small z stagger for the crossbar
      return new THREE.Mesh(gm, gold);
    }
    const proto = new THREE.Group();
    proto.add(bar([[-48, 0], [-30, 0], [-2, 100], [-14, 100]], 0));   // left leg  (peak on the left)
    proto.add(bar([[48, 0], [30, 0], [2, 100], [14, 100]], 0));       // right leg (mirror)
    proto.add(bar([[-22, 40], [22, 40], [22, 54], [-22, 54]], 1.2));  // crossbar, floated proud

    const sc = 0.6; // fit the ~100-tall A onto the 100 face with margin
    const faces = [
      { ry: 0, x: 0, z: C / 2 },
      { ry: Math.PI / 2, x: C / 2, z: 0 },
      { ry: Math.PI, x: 0, z: -C / 2 },
      { ry: -Math.PI / 2, x: -C / 2, z: 0 }
    ];
    faces.forEach(f => {
      const gA = proto.clone();
      gA.scale.setScalar(sc);
      gA.rotation.y = f.ry;
      gA.position.set(f.x, 0, f.z); // base sits on the face; extrusion protrudes outward
      root.add(gA);
    });
    return root;
  }

  function init(canvas, svgText) {
    const THREE = g.THREE;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(Math.min(g.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene();
    const vb = vbSize(svgText);
    const depth = Math.max(6, 0.11 * Math.min(vb.w, vb.h));
    const grp = new THREE.Group();

    // ascender is the only mark with a url() gradient fill referencing id "ag"
    const isAscender = svgText.indexOf('url(#ag)') !== -1;

    if (isAscender) {
      grp.add(buildAscender(THREE));
      grp.scale.y = 1; // cube+A already built upright; no SVG y-flip needed
    } else {
      const data = new THREE.SVGLoader().parse(svgText);
      const zStep = Math.max(0.5, depth * 0.05); // stagger each path in paint order so coplanar faces never z-fight (blink)
      const sStep = Math.max(0.4, depth * 0.06); // per-subpath stroke stagger
      const strokeByColor = new Map();           // hex -> { color, accent, geos:[] }
      let si = 0;
      data.paths.forEach((p, i) => {
        const style = (p.userData && p.userData.style) || {};
        const hasFill = style.fill === undefined || style.fill !== 'none';
        const hasStroke = typeof style.stroke === 'string' && style.stroke !== 'none' && style.stroke !== '';
        const zPos = i * zStep;
        // --- filled shapes (with holes preserved via toShapes) ---
        if (hasFill) {
          const col = resolveFill(THREE, style, p, svgText);
          const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, metalness: 0.16, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 - i, polygonOffsetUnits: -1 - i });
          (p.toShapes(true) || []).forEach(sh => {
            const geo = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: true, bevelThickness: depth * 0.12, bevelSize: depth * 0.09, bevelSegments: 2, curveSegments: 14 });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.z = zPos;
            grp.add(mesh);
          });
        }
        // --- stroke-only / stroked subpaths (monoline): collect solid bars per colour ---
        if (hasStroke) {
          const col = (function () { try { return new THREE.Color(style.stroke); } catch (e) { return new THREE.Color('#6B4CA6'); } })();
          const sStyle = THREE.SVGLoader.getStrokeStyle(
            parseFloat(style.strokeWidth) || 1,
            style.stroke,
            style.strokeLineJoin || 'round',
            style.strokeLineCap || 'round',
            parseFloat(style.strokeMiterLimit) || 4
          );
          (p.subPaths || []).forEach(sp => {
            const pts = sp.getPoints();
            if (!pts || pts.length < 2) return;
            const flat = THREE.SVGLoader.pointsToStroke(pts, sStyle, 12);
            if (!flat) return;
            const geo = thicken(THREE, flat, depth);
            geo.translate(0, 0, si * sStep); // tiny stagger: no two caps exactly coplanar
            si++;
            const hex = col.getHexString();
            let rec = strokeByColor.get(hex);
            if (!rec) { rec = { color: col, accent: isAccent(col), geos: [] }; strokeByColor.set(hex, rec); }
            rec.geos.push(geo);
          });
        }
      });
      // Merge each colour's bars into ONE mesh; float the accent (gold) in front of the body.
      strokeByColor.forEach(rec => {
        const merged = mergeGeos(THREE, rec.geos);
        const mat = new THREE.MeshStandardMaterial({ color: rec.color, roughness: 0.5, metalness: 0.16, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        const mesh = new THREE.Mesh(merged, mat);
        mesh.position.z = rec.accent ? depth * 0.6 : 0; // clean depth separation gold vs purple
        grp.add(mesh);
      });
      grp.scale.y = -1; // SVG y-down -> Three y-up
    }

    const box = new THREE.Box3().setFromObject(grp);
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    grp.position.sub(c);
    const pivot = new THREE.Group(); pivot.add(grp); scene.add(pivot);
    const R = Math.max(s.x, s.y) * 0.5 || 100;

    const cam = new THREE.PerspectiveCamera(32, 1, 1, R * 80);
    // slight downward tilt shows the cube's top face (reads as 3D); flat marks stay near head-on
    if (isAscender) cam.position.set(0, R * 0.55, R * 5.2);
    else cam.position.set(0, R * 0.1, R * 5.7);
    cam.lookAt(0, 0, 0); // pull back so rotating marks never crop
    scene.add(new THREE.AmbientLight(0xffffff, 0.74));
    const k = new THREE.DirectionalLight(0xffffff, 0.95); k.position.set(-1, 1.35, 1.4); scene.add(k);
    const f = new THREE.DirectionalLight(0xcdb8ff, 0.35); f.position.set(1.2, 0.1, -0.9); scene.add(f);

    const ctr = new THREE.OrbitControls(cam, renderer.domElement);
    ctr.enableDamping = true; ctr.dampingFactor = 0.08; ctr.enablePan = false;
    ctr.minDistance = R * 2.4; ctr.maxDistance = R * 9;
    ctr.autoRotate = true; ctr.autoRotateSpeed = 2.4;

    function rs() { const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
    function loop() { requestAnimationFrame(loop); if (canvas.dataset.paused === '1') return; rs(); ctr.update(); renderer.render(scene, cam); }
    loop();
    if ('IntersectionObserver' in g) new IntersectionObserver(es => es.forEach(e => { canvas.dataset.paused = e.isIntersecting ? '0' : '1'; }), { rootMargin: '120px' }).observe(canvas);
  }
  g.LogoExtrude = { init };
})(window);
